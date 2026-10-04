import { WebClient } from '@slack/web-api';
import pLimit from 'p-limit';
import type {
  Channel,
  ChannelDetail,
  ChannelLastRead,
  ChannelMembersOptions,
  ChannelMembersResult,
  LastReadFailureReason,
  ListChannelsOptions,
} from '../../types/slack';
import { channelResolver } from '../channel-resolver';
import { DEFAULTS, RATE_LIMIT } from '../constants';
import { extractErrorMessage, getSlackErrorCode, getSlackNeededScopes } from '../error-utils';
import { sanitizeTerminalText } from '../terminal-sanitizer';
import { BaseSlackClient, SlackClientDependency } from './base-client';

interface ChannelWithUnreadInfo extends Channel {
  unread_count: number;
  unread_count_display: number;
  last_read?: string;
}

type ChannelLookupType = 'public_channel' | 'private_channel' | 'im' | 'mpim';

const DEFAULT_CHANNEL_LOOKUP_TYPES: ChannelLookupType[] = [
  'public_channel',
  'private_channel',
  'im',
  'mpim',
];

const MISSING_SCOPE_TO_CHANNEL_TYPE: Partial<Record<string, ChannelLookupType>> = {
  'channels:read': 'public_channel',
  'groups:read': 'private_channel',
  'im:read': 'im',
  'mpim:read': 'mpim',
};

// @slack/web-api の ErrorCode と同じ値。ErrorCode を import しないのは、@slack/web-api を
// 一部の export だけでモックするテストが多く、モックに無い export に触れると例外になるため
const WEB_API_ERROR_CODE = {
  PLATFORM: 'slack_webapi_platform_error',
  RATE_LIMITED: 'slack_webapi_rate_limited_error',
} as const;

// 認証の失敗。会話ごとの失敗にはせず、全体の失敗として投げる
const AUTH_FAILURE_ERRORS = new Set([
  'invalid_auth',
  'not_authed',
  'token_revoked',
  'token_expired',
  'account_inactive',
]);

// 会話が見えない（参加していない・権限が無い）ときの Slack のエラー
const NOT_VISIBLE_ERRORS = new Set(['channel_not_found', 'missing_scope']);

interface LastReadOutcome {
  result: ChannelLastRead;
  // 標準エラーに出す1行の補足（取れたときは無い）
  detail?: string;
}

function readProperty(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

// Slack のエラー名（data.error）。@slack/web-api が Slack の応答から作ったエラーのときだけ読む
function getPlatformErrorName(error: unknown): string | undefined {
  if (readProperty(error, 'code') !== WEB_API_ERROR_CODE.PLATFORM) {
    return undefined;
  }
  const name = readProperty(readProperty(error, 'data'), 'error');
  return typeof name === 'string' ? name : undefined;
}

function isAuthFailure(error: unknown): boolean {
  const name = getPlatformErrorName(error);
  return name !== undefined && AUTH_FAILURE_ERRORS.has(name);
}

function rateLimitedRow(channelId: string, retryAfter: number | undefined): ChannelLastRead {
  return {
    channelId,
    lastRead: null,
    reason: 'rate_limited',
    ...(retryAfter !== undefined && { retryAfter }),
  };
}

// 取れなかった理由を、エラーの code と data.error で分ける（文の「rate limit」の有無は見ない）。
// 認証の失敗は呼び出し側が先に取り除く
function classifyLastReadFailure(channelId: string, error: unknown): LastReadOutcome {
  const detail = extractErrorMessage(error);

  if (readProperty(error, 'code') === WEB_API_ERROR_CODE.RATE_LIMITED) {
    const retryAfter = readProperty(error, 'retryAfter');
    return {
      result: rateLimitedRow(
        channelId,
        typeof retryAfter === 'number' && Number.isFinite(retryAfter) ? retryAfter : undefined
      ),
      detail,
    };
  }

  const name = getPlatformErrorName(error);
  const reason: LastReadFailureReason =
    name !== undefined && NOT_VISIBLE_ERRORS.has(name) ? 'not_visible' : 'error';
  return { result: { channelId, lastRead: null, reason }, detail };
}

export class ChannelOperations extends BaseSlackClient {
  private channelLookupCache?: Promise<Channel[]>;

  constructor(tokenOrClient: SlackClientDependency) {
    super(tokenOrClient as string | WebClient);
  }

  async listChannels(options: ListChannelsOptions): Promise<Channel[]> {
    const channels: Channel[] = [];
    let cursor: string | undefined;

    do {
      const params = {
        types: options.types,
        exclude_archived: options.exclude_archived,
        limit: options.limit,
        cursor,
      };
      // users.conversations returns only conversations the authenticated user belongs to
      const response = options.member_only
        ? await this.client.users.conversations(params)
        : await this.client.conversations.list(params);

      if (response.channels) {
        channels.push(...(response.channels as Channel[]));
      }

      cursor = response.response_metadata?.next_cursor;
    } while (cursor);

    return channels;
  }

  async listUnreadChannels(): Promise<Channel[]> {
    const channels = await this.fetchUserChannels();
    const unreadScanLimiter = pLimit(RATE_LIMIT.UNREAD_SCAN_CONCURRENT_REQUESTS);
    const unreadChannels = await Promise.all(
      channels.map((channel) =>
        unreadScanLimiter(async () => {
          try {
            return await this.getChannelUnreadInfo(channel);
          } catch (error) {
            await this.handleRateLimit(error);
            return null;
          }
        })
      )
    );

    return unreadChannels.filter((channel): channel is Channel => channel !== null);
  }

  async fetchUserChannels(): Promise<Channel[]> {
    const channels: Channel[] = [];
    let cursor: string | undefined;

    do {
      const response = await this.client.users.conversations({
        types: 'public_channel,private_channel,im,mpim',
        exclude_archived: true,
        limit: 200,
        cursor,
      });

      if (response.channels) {
        channels.push(...(response.channels as Channel[]));
      }

      cursor = response.response_metadata?.next_cursor;
    } while (cursor);

    return channels;
  }

  async enrichUnreadChannels(channels: Channel[]): Promise<Channel[]> {
    const unreadScanLimiter = pLimit(RATE_LIMIT.UNREAD_SCAN_CONCURRENT_REQUESTS);

    const enrichedChannels = await Promise.all(
      channels.map((channel) =>
        unreadScanLimiter(async () => {
          try {
            const channelInfo = await this.fetchChannelInfo(channel.id);
            return await this.buildUnreadChannel(
              channel,
              channelInfo,
              channel.unread_count_display ?? channel.unread_count ?? 0
            );
          } catch (error) {
            await this.handleRateLimit(error);
            return channel;
          }
        })
      )
    );

    return enrichedChannels;
  }

  /**
   * Count the given messages that are newer than each conversation's last_read position.
   * Conversations without unread messages, or whose info cannot be fetched, are omitted.
   */
  async countUnreadSinceLastRead(
    candidates: { channel: Channel; timestamps: string[] }[]
  ): Promise<Channel[]> {
    const unreadScanLimiter = pLimit(RATE_LIMIT.UNREAD_SCAN_CONCURRENT_REQUESTS);

    const results = await Promise.all(
      candidates.map(({ channel, timestamps }) =>
        unreadScanLimiter(async () => {
          try {
            const channelInfo = await this.fetchChannelInfo(channel.id);
            const lastRead = Number.parseFloat(channelInfo.last_read || '0');
            const unreadCount = timestamps.filter((ts) => Number.parseFloat(ts) > lastRead).length;
            return unreadCount > 0
              ? await this.buildUnreadChannel(channel, channelInfo, unreadCount)
              : null;
          } catch (error) {
            // Omitting silently would look the same as "no unread", so say which conversation was skipped
            console.error(
              `Warning: skipped ${channel.id}: ${sanitizeTerminalText(extractErrorMessage(error))}`
            );
            await this.handleRateLimit(error);
            return null;
          }
        })
      )
    );

    return results.filter((channel): channel is Channel => channel !== null);
  }

  /**
   * 会話ごとの last_read を、入力の順に返す。取れない会話は lastRead を null にし、reason に理由を入れる。
   *
   * 呼び出し側のプログラムが読む前提なので、fetchChannelInfo と違って再試行せず、回数制限でも待たない
   * （待たずに失敗させるには、クライアントを rejectRateLimitedCalls 付きで作る）。
   * - 1件が回数制限になったら、まだ呼んでいない会話は呼ばずに rate_limited を返す
   * - 認証の失敗は会話ごとの失敗にせず、全体の失敗として投げる
   */
  async getLastReads(channelIds: string[]): Promise<ChannelLastRead[]> {
    const limiter = pLimit(RATE_LIMIT.UNREAD_SCAN_CONCURRENT_REQUESTS);
    // 最初に回数制限を受けた秒数。受けたあとは、まだ呼んでいない会話を呼ばない
    let rateLimited: { retryAfter?: number } | undefined;
    // 認証が失敗したあとは、まだ呼んでいない会話を呼ばず、同じエラーで終える
    let authFailure: { error: unknown } | undefined;

    const outcomes = await Promise.all(
      channelIds.map((channelId) =>
        limiter(async (): Promise<LastReadOutcome> => {
          if (authFailure) {
            throw authFailure.error;
          }
          if (rateLimited) {
            const { retryAfter } = rateLimited;
            return {
              result: rateLimitedRow(channelId, retryAfter),
              detail:
                retryAfter !== undefined
                  ? `not requested after an earlier rate limit, retry after ${retryAfter} seconds`
                  : 'not requested after an earlier rate limit',
            };
          }

          let lastRead: unknown;
          try {
            const info = await this.client.conversations.info({
              channel: channelId,
              include_num_members: false,
            });
            lastRead = (info.channel as ChannelWithUnreadInfo | undefined)?.last_read;
          } catch (error) {
            if (isAuthFailure(error)) {
              authFailure = authFailure ?? { error };
              throw error;
            }
            const outcome = classifyLastReadFailure(channelId, error);
            if (outcome.result.reason === 'rate_limited') {
              rateLimited = rateLimited ?? { retryAfter: outcome.result.retryAfter };
            }
            return outcome;
          }

          if (typeof lastRead === 'string' && lastRead.length > 0) {
            return { result: { channelId, lastRead, reason: null } };
          }
          return { result: { channelId, lastRead: null, reason: 'no_last_read' } };
        })
      )
    );

    // 取れなかった会話は、理由を標準エラーに1行ずつ出す（全件の取得が終わってから、入力の順で）
    for (const { result, detail } of outcomes) {
      if (result.reason !== null) {
        const suffix = detail ? ` (${sanitizeTerminalText(detail)})` : '';
        console.error(
          `Warning: skipped ${sanitizeTerminalText(result.channelId)}: ${result.reason}${suffix}`
        );
      }
    }

    return outcomes.map(({ result }) => result);
  }

  async resolveChannelId(channelNameOrId: string): Promise<string> {
    return channelResolver.resolveChannelId(channelNameOrId, async () =>
      this.getChannelLookupCache()
    );
  }

  private getChannelLookupCache(): Promise<Channel[]> {
    if (!this.channelLookupCache) {
      this.channelLookupCache = this.fetchChannelLookupChannels().catch((error) => {
        this.channelLookupCache = undefined;
        throw error;
      });
    }

    return this.channelLookupCache;
  }

  private async fetchChannelLookupChannels(
    types: ChannelLookupType[] = DEFAULT_CHANNEL_LOOKUP_TYPES
  ): Promise<Channel[]> {
    try {
      return await this.listChannels({
        types: types.join(','),
        exclude_archived: true,
        limit: DEFAULTS.CHANNELS_LIMIT,
      });
    } catch (error) {
      const fallbackTypes = this.getFallbackChannelLookupTypes(error, types);
      if (!fallbackTypes) {
        throw error;
      }

      return this.listChannels({
        types: fallbackTypes.join(','),
        exclude_archived: true,
        limit: DEFAULTS.CHANNELS_LIMIT,
      });
    }
  }

  private getFallbackChannelLookupTypes(
    error: unknown,
    requestedTypes: ChannelLookupType[]
  ): ChannelLookupType[] | null {
    if (getSlackErrorCode(error) !== 'missing_scope') {
      return null;
    }

    const blockedTypes = new Set(
      getSlackNeededScopes(error)
        .map((scope) => MISSING_SCOPE_TO_CHANNEL_TYPE[scope])
        .filter((channelType): channelType is ChannelLookupType => channelType !== undefined)
    );

    if (blockedTypes.size === 0) {
      return null;
    }

    const fallbackTypes = requestedTypes.filter((channelType) => !blockedTypes.has(channelType));
    if (fallbackTypes.length === 0 || fallbackTypes.length === requestedTypes.length) {
      return null;
    }

    return fallbackTypes;
  }

  private async getChannelUnreadInfo(channel: Channel): Promise<Channel | null> {
    const hasUnreadCount =
      channel.unread_count !== undefined || channel.unread_count_display !== undefined;
    const needsChannelInfo =
      !hasUnreadCount || (!channel.name && !channel.is_im && !channel.is_mpim);
    const channelInfo = needsChannelInfo ? await this.fetchChannelInfo(channel.id) : undefined;
    const unreadCount =
      channel.unread_count_display ??
      channel.unread_count ??
      channelInfo?.unread_count_display ??
      channelInfo?.unread_count ??
      0;

    if (unreadCount > 0) {
      return this.buildUnreadChannel(channel, channelInfo, unreadCount);
    }

    return null;
  }

  private async fetchChannelInfo(channelId: string): Promise<ChannelWithUnreadInfo> {
    for (let attempt = 0; ; attempt++) {
      try {
        const info = await this.client.conversations.info({
          channel: channelId,
          include_num_members: false,
        });
        return info.channel as ChannelWithUnreadInfo;
      } catch (error) {
        const isRateLimitError = error instanceof Error && error.message?.includes('rate limit');
        if (!isRateLimitError || attempt >= RATE_LIMIT.RETRY_CONFIG.retries) {
          throw error;
        }

        await this.handleRateLimit(error);
      }
    }
  }

  private async resolveChannelDisplayName(
    channel: ChannelWithUnreadInfo
  ): Promise<string | undefined> {
    const conversationName = channel.name;
    if (conversationName && conversationName !== channel.id) {
      return undefined;
    }

    if (channel.is_im && channel.user) {
      try {
        const response = await this.client.users.info({ user: channel.user });
        const user = response.user as { name?: string; profile?: { display_name?: string } };
        const username = user.profile?.display_name || user.name || channel.user;
        return sanitizeTerminalText(`@${username}`);
      } catch {
        return sanitizeTerminalText(`@${channel.user}`);
      }
    }

    if (channel.is_mpim) {
      const purpose = channel.purpose?.value?.trim();
      if (purpose) {
        return sanitizeTerminalText(purpose);
      }
    }

    return sanitizeTerminalText(channel.id);
  }

  private async buildUnreadChannel(
    channel: Channel,
    channelInfo?: ChannelWithUnreadInfo,
    unreadCount = 0
  ): Promise<Channel> {
    const mergedChannel: ChannelWithUnreadInfo = {
      ...channelInfo,
      ...channel,
      unread_count: unreadCount,
      unread_count_display: unreadCount,
      last_read: channel.last_read ?? channelInfo?.last_read,
    };
    const name = mergedChannel.name || channelInfo?.id || channel.id;
    const display_name = mergedChannel.display_name
      ? sanitizeTerminalText(mergedChannel.display_name)
      : await this.resolveChannelDisplayName(mergedChannel);

    return {
      ...mergedChannel,
      name,
      display_name,
    };
  }

  async getChannelInfo(channelNameOrId: string): Promise<ChannelWithUnreadInfo> {
    const channelId = await this.resolveChannelId(channelNameOrId);

    const info = await this.client.conversations.info({
      channel: channelId,
    });

    return info.channel as ChannelWithUnreadInfo;
  }

  async getChannelDetail(channelNameOrId: string): Promise<ChannelDetail> {
    const channelId = await this.resolveChannelId(channelNameOrId);

    const info = await this.client.conversations.info({
      channel: channelId,
      include_num_members: true,
    });

    return info.channel as ChannelDetail;
  }

  async setTopic(channelNameOrId: string, topic: string): Promise<void> {
    const channelId = await this.resolveChannelId(channelNameOrId);

    await this.client.conversations.setTopic({
      channel: channelId,
      topic,
    });
  }

  async setPurpose(channelNameOrId: string, purpose: string): Promise<void> {
    const channelId = await this.resolveChannelId(channelNameOrId);

    await this.client.conversations.setPurpose({
      channel: channelId,
      purpose,
    });
  }

  async joinChannel(channelNameOrId: string): Promise<void> {
    const channelId = await this.resolveChannelId(channelNameOrId);

    await this.client.conversations.join({
      channel: channelId,
    });
  }

  async leaveChannel(channelNameOrId: string): Promise<void> {
    const channelId = await this.resolveChannelId(channelNameOrId);

    await this.client.conversations.leave({
      channel: channelId,
    });
  }

  async inviteToChannel(
    channelNameOrId: string,
    userIds: string[],
    force?: boolean
  ): Promise<void> {
    const channelId = await this.resolveChannelId(channelNameOrId);

    await this.client.conversations.invite({
      channel: channelId,
      users: userIds.join(','),
      ...(force && { force }),
    });
  }

  async getChannelMembers(
    channelNameOrId: string,
    options: ChannelMembersOptions = {}
  ): Promise<ChannelMembersResult> {
    const channelId = await this.resolveChannelId(channelNameOrId);

    const response = await this.client.conversations.members({
      channel: channelId,
      limit: options.limit ?? 100,
      cursor: options.cursor,
    });

    return {
      members: (response.members as string[]) || [],
      nextCursor: response.response_metadata?.next_cursor || '',
    };
  }
}
