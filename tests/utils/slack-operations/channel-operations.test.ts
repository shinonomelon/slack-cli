import * as slackErrors from '@slack/web-api/dist/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RATE_LIMIT } from '../../../src/utils/constants';
import { ChannelOperations } from '../../../src/utils/slack-operations/channel-operations';

vi.mock('@slack/web-api', () => ({
  WebClient: vi.fn().mockImplementation(function () {
    return {
      conversations: {
        list: vi.fn(),
        info: vi.fn(),
        history: vi.fn(),
      },
      users: {
        conversations: vi.fn(),
        info: vi.fn(),
      },
    };
  }),
  LogLevel: {
    ERROR: 'error',
  },
}));

// ふだんの p-limit は並列数を数えず、すぐ実行する（モック）。
// getLastReads のテストだけ本物に切り替える。「並列は15」と「回数制限のあと、まだ呼んでいない
// 会話を呼ばない」は、並列数を守る本物の p-limit でしか確かめられないため
const limiterMode = vi.hoisted(() => ({ useActual: false }));

vi.mock('p-limit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('p-limit')>();
  return {
    default: (concurrency: number) =>
      limiterMode.useActual ? actual.default(concurrency) : (fn: () => unknown) => fn(),
  };
});

describe('ChannelOperations', () => {
  type MockClient = {
    conversations: {
      list: ReturnType<typeof vi.fn>;
      info: ReturnType<typeof vi.fn>;
      history: ReturnType<typeof vi.fn>;
    };
    users: {
      conversations: ReturnType<typeof vi.fn>;
      info: ReturnType<typeof vi.fn>;
    };
  };

  let channelOps: ChannelOperations;
  let mockClient: MockClient;

  const createMissingScopeError = (needed: string) =>
    Object.assign(new Error('An API error occurred: missing_scope'), {
      data: {
        error: 'missing_scope',
        needed,
      },
    });

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = {
      conversations: {
        list: vi.fn(),
        info: vi.fn(),
        history: vi.fn(),
      },
      users: {
        conversations: vi.fn(),
        info: vi.fn(),
      },
    };
    // Create instance with mocked token
    channelOps = new ChannelOperations('test-token');
    // Replace the client with our mock
    (channelOps as unknown as { client: MockClient }).client = mockClient;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('fetchUserChannels', () => {
    it('should use users.conversations API to fetch user channels', async () => {
      mockClient.users.conversations.mockResolvedValue({
        channels: [
          { id: 'C123', name: 'general' },
          { id: 'C456', name: 'random' },
        ],
        response_metadata: { next_cursor: '' },
      });

      const result = await channelOps.fetchUserChannels();

      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({ id: 'C123', name: 'general' });
      expect(result[1]).toMatchObject({ id: 'C456', name: 'random' });
      expect(mockClient.users.conversations).toHaveBeenCalledWith({
        types: 'public_channel,private_channel,im,mpim',
        exclude_archived: true,
        limit: 200,
        cursor: undefined,
      });
    });

    it('should handle pagination with next_cursor', async () => {
      mockClient.users.conversations
        .mockResolvedValueOnce({
          channels: [
            { id: 'C001', name: 'channel-1' },
            { id: 'C002', name: 'channel-2' },
          ],
          response_metadata: { next_cursor: 'cursor_page2' },
        })
        .mockResolvedValueOnce({
          channels: [{ id: 'C003', name: 'channel-3' }],
          response_metadata: { next_cursor: '' },
        });

      const result = await channelOps.fetchUserChannels();

      expect(result).toHaveLength(3);
      expect(result[0].id).toBe('C001');
      expect(result[1].id).toBe('C002');
      expect(result[2].id).toBe('C003');
      expect(mockClient.users.conversations).toHaveBeenCalledTimes(2);
      expect(mockClient.users.conversations).toHaveBeenNthCalledWith(2, {
        types: 'public_channel,private_channel,im,mpim',
        exclude_archived: true,
        limit: 200,
        cursor: 'cursor_page2',
      });
    });

    it('should handle multiple pages of pagination', async () => {
      mockClient.users.conversations
        .mockResolvedValueOnce({
          channels: [{ id: 'C001', name: 'ch1' }],
          response_metadata: { next_cursor: 'cursor2' },
        })
        .mockResolvedValueOnce({
          channels: [{ id: 'C002', name: 'ch2' }],
          response_metadata: { next_cursor: 'cursor3' },
        })
        .mockResolvedValueOnce({
          channels: [{ id: 'C003', name: 'ch3' }],
          response_metadata: { next_cursor: '' },
        });

      const result = await channelOps.fetchUserChannels();

      expect(result).toHaveLength(3);
      expect(mockClient.users.conversations).toHaveBeenCalledTimes(3);
    });

    it('should return empty array when user has no channels', async () => {
      mockClient.users.conversations.mockResolvedValue({
        channels: [],
        response_metadata: { next_cursor: '' },
      });

      const result = await channelOps.fetchUserChannels();

      expect(result).toHaveLength(0);
    });

    it('should include all channel types (public, private, im, mpim)', async () => {
      mockClient.users.conversations.mockResolvedValue({
        channels: [
          { id: 'C001', name: 'public-ch', is_channel: true },
          { id: 'G001', name: 'private-ch', is_group: true },
          { id: 'D001', name: 'dm', is_im: true },
          { id: 'G002', name: 'group-dm', is_mpim: true },
        ],
        response_metadata: { next_cursor: '' },
      });

      const result = await channelOps.fetchUserChannels();

      expect(result).toHaveLength(4);
      expect(mockClient.users.conversations).toHaveBeenCalledWith(
        expect.objectContaining({
          types: 'public_channel,private_channel,im,mpim',
        })
      );
    });

    it('should handle undefined channels in response', async () => {
      mockClient.users.conversations.mockResolvedValue({
        response_metadata: { next_cursor: '' },
      });

      const result = await channelOps.fetchUserChannels();

      expect(result).toHaveLength(0);
    });
  });

  describe('resolveChannelId', () => {
    it('should reuse the cached channel list across resolutions', async () => {
      mockClient.conversations.list.mockResolvedValue({
        channels: [
          { id: 'C123', name: 'general', is_channel: true, is_private: false, created: 1 },
          { id: 'C456', name: 'random', is_channel: true, is_private: false, created: 1 },
        ],
        response_metadata: { next_cursor: '' },
      });

      await expect(channelOps.resolveChannelId('general')).resolves.toBe('C123');
      await expect(channelOps.resolveChannelId('random')).resolves.toBe('C456');

      expect(mockClient.conversations.list).toHaveBeenCalledTimes(1);
    });

    it('should clear the cached promise after a lookup fetch failure', async () => {
      mockClient.conversations.list
        .mockRejectedValueOnce(new Error('temporary failure'))
        .mockResolvedValueOnce({
          channels: [
            { id: 'C123', name: 'general', is_channel: true, is_private: false, created: 1 },
          ],
          response_metadata: { next_cursor: '' },
        });

      await expect(channelOps.resolveChannelId('general')).rejects.toThrow('temporary failure');
      await expect(channelOps.resolveChannelId('general')).resolves.toBe('C123');

      expect(mockClient.conversations.list).toHaveBeenCalledTimes(2);
    });

    it('should retry channel lookup without private channels after groups:read missing_scope', async () => {
      mockClient.conversations.list
        .mockRejectedValueOnce(createMissingScopeError('groups:read'))
        .mockResolvedValueOnce({
          channels: [
            { id: 'C123', name: 'general', is_channel: true, is_private: false, created: 1 },
          ],
          response_metadata: { next_cursor: '' },
        });

      await expect(channelOps.resolveChannelId('general')).resolves.toBe('C123');

      expect(mockClient.conversations.list).toHaveBeenCalledTimes(2);
      expect(mockClient.conversations.list).toHaveBeenNthCalledWith(1, {
        types: 'public_channel,private_channel,im,mpim',
        exclude_archived: true,
        limit: 1000,
        cursor: undefined,
      });
      expect(mockClient.conversations.list).toHaveBeenNthCalledWith(2, {
        types: 'public_channel,im,mpim',
        exclude_archived: true,
        limit: 1000,
        cursor: undefined,
      });
    });

    it('should cache the successful fallback channel lookup', async () => {
      mockClient.conversations.list
        .mockRejectedValueOnce(createMissingScopeError('groups:read'))
        .mockResolvedValueOnce({
          channels: [
            { id: 'C123', name: 'general', is_channel: true, is_private: false, created: 1 },
            { id: 'C456', name: 'random', is_channel: true, is_private: false, created: 1 },
          ],
          response_metadata: { next_cursor: '' },
        });

      await expect(channelOps.resolveChannelId('general')).resolves.toBe('C123');
      await expect(channelOps.resolveChannelId('random')).resolves.toBe('C456');

      expect(mockClient.conversations.list).toHaveBeenCalledTimes(2);
    });

    it('should rethrow missing_scope when no lookup types remain after fallback', async () => {
      const missingScopeError = createMissingScopeError(
        'channels:read,groups:read,im:read,mpim:read'
      );
      mockClient.conversations.list.mockRejectedValueOnce(missingScopeError);

      await expect(channelOps.resolveChannelId('general')).rejects.toBe(missingScopeError);
      expect(mockClient.conversations.list).toHaveBeenCalledTimes(1);
    });

    it('should rethrow missing_scope when needed scopes do not map to channel lookup types', async () => {
      const missingScopeError = createMissingScopeError('chat:write');
      mockClient.conversations.list.mockRejectedValueOnce(missingScopeError);

      await expect(channelOps.resolveChannelId('general')).rejects.toBe(missingScopeError);
      expect(mockClient.conversations.list).toHaveBeenCalledTimes(1);
    });

    it('should not retry on non-missing_scope errors', async () => {
      mockClient.conversations.list.mockRejectedValueOnce(new Error('invalid_auth'));

      await expect(channelOps.resolveChannelId('general')).rejects.toThrow('invalid_auth');
      expect(mockClient.conversations.list).toHaveBeenCalledTimes(1);
    });
  });

  describe('listUnreadChannels', () => {
    it('should use users.conversations instead of conversations.list', async () => {
      // Mock users.conversations response (used by fetchUserChannels)
      mockClient.users.conversations.mockResolvedValue({
        channels: [{ id: 'C123', name: 'general', unread_count: 1, unread_count_display: 1 }],
        response_metadata: { next_cursor: '' },
      });

      await channelOps.listUnreadChannels();

      // Should use users.conversations, NOT conversations.list
      expect(mockClient.users.conversations).toHaveBeenCalled();
      expect(mockClient.conversations.list).not.toHaveBeenCalled();
    });

    it('should detect unread messages when last_read is present', async () => {
      // Mock users.conversations response
      mockClient.users.conversations.mockResolvedValue({
        channels: [
          {
            id: 'C123',
            name: 'general',
            last_read: '1234567890.000100',
            unread_count: 2,
            unread_count_display: 2,
          },
          {
            id: 'C456',
            name: 'random',
            last_read: '1234567890.000200',
            unread_count: 0,
            unread_count_display: 0,
          },
        ],
        response_metadata: { next_cursor: '' },
      });

      const result = await channelOps.listUnreadChannels();

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: 'C123',
        name: 'general',
        unread_count: 2,
        unread_count_display: 2,
        last_read: '1234567890.000100',
      });
    });

    it('should count all messages as unread when last_read is not present', async () => {
      // Mock users.conversations response
      mockClient.users.conversations.mockResolvedValue({
        channels: [
          {
            id: 'C789',
            name: 'no-read-channel',
            unread_count: 3,
            unread_count_display: 3,
          },
        ],
        response_metadata: { next_cursor: '' },
      });

      const result = await channelOps.listUnreadChannels();

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: 'C789',
        name: 'no-read-channel',
        unread_count: 3,
        unread_count_display: 3,
        last_read: undefined,
      });
    });

    it('should skip channels with no messages', async () => {
      mockClient.users.conversations.mockResolvedValue({
        channels: [{ id: 'C999', name: 'empty-channel', unread_count: 0, unread_count_display: 0 }],
        response_metadata: { next_cursor: '' },
      });

      const result = await channelOps.listUnreadChannels();

      expect(result).toHaveLength(0);
    });

    it('should skip channels with all messages read', async () => {
      mockClient.users.conversations.mockResolvedValue({
        channels: [{ id: 'C111', name: 'all-read', unread_count: 0, unread_count_display: 0 }],
        response_metadata: { next_cursor: '' },
      });

      const result = await channelOps.listUnreadChannels();

      expect(result).toHaveLength(0);
    });

    it('should handle API errors gracefully', async () => {
      mockClient.users.conversations.mockResolvedValue({
        channels: [
          { id: 'C222', name: 'error-channel' },
          { id: 'C333', name: 'good-channel', unread_count: 1, unread_count_display: 1 },
        ],
        response_metadata: { next_cursor: '' },
      });

      mockClient.conversations.info.mockRejectedValueOnce(new Error('API Error'));

      const result = await channelOps.listUnreadChannels();

      // Should skip the error channel and process the good one
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('C333');
    });

    it('should skip channels whose unread info lookup fails after rate-limit handling', async () => {
      vi.useFakeTimers();
      mockClient.users.conversations.mockResolvedValue({
        channels: [{ id: 'C222' }],
        response_metadata: { next_cursor: '' },
      });
      mockClient.conversations.info.mockRejectedValue(new Error('rate limit'));

      const resultPromise = channelOps.listUnreadChannels();
      await vi.advanceTimersByTimeAsync(20000);

      await expect(resultPromise).resolves.toEqual([]);
    });

    it('should enrich unread channels but keep originals when enrichment fails', async () => {
      vi.useFakeTimers();
      const originalChannel = { id: 'C222', unread_count: 1 };
      mockClient.conversations.info.mockRejectedValue(new Error('rate limit'));

      const resultPromise = channelOps.enrichUnreadChannels([originalChannel]);
      await vi.advanceTimersByTimeAsync(20000);

      await expect(resultPromise).resolves.toEqual([originalChannel]);
    });

    it('should retry channel info lookups after transient rate limits', async () => {
      vi.useFakeTimers();
      mockClient.users.conversations.mockResolvedValue({
        channels: [{ id: 'C777' }],
        response_metadata: { next_cursor: '' },
      });
      mockClient.conversations.info
        .mockRejectedValueOnce(new Error('rate limit'))
        .mockResolvedValueOnce({
          channel: {
            id: 'C777',
            name: 'busy-channel',
            unread_count: 3,
            unread_count_display: 3,
          },
        });

      const resultPromise = channelOps.listUnreadChannels();
      await vi.advanceTimersByTimeAsync(5000);

      await expect(resultPromise).resolves.toEqual([
        expect.objectContaining({
          id: 'C777',
          name: 'busy-channel',
          unread_count: 3,
        }),
      ]);
      expect(mockClient.conversations.info).toHaveBeenCalledTimes(2);
    });

    it('should avoid conversations.info when users.conversations already includes unread counters', async () => {
      mockClient.users.conversations.mockResolvedValue({
        channels: [
          { id: 'C444', name: 'channel1', unread_count: 2, unread_count_display: 2 },
          { id: 'C555', name: 'channel2', unread_count: 0, unread_count_display: 0 },
        ],
        response_metadata: { next_cursor: '' },
      });

      await channelOps.listUnreadChannels();

      expect(mockClient.conversations.info).not.toHaveBeenCalled();
    });

    it('should use unread counters from conversations.info when users.conversations omits them', async () => {
      mockClient.users.conversations.mockResolvedValue({
        channels: [{ id: 'C777', name: 'busy-channel' }],
        response_metadata: { next_cursor: '' },
      });

      mockClient.conversations.info.mockResolvedValue({
        channel: {
          id: 'C777',
          name: 'busy-channel',
          last_read: '1234567890.000100',
          unread_count: 3,
          unread_count_display: 3,
        },
      });

      const result = await channelOps.listUnreadChannels();

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: 'C777',
        unread_count: 3,
        unread_count_display: 3,
      });
      expect(mockClient.conversations.history).not.toHaveBeenCalled();
    });

    it('should use channel name from conversations.info when users.conversations omits it', async () => {
      mockClient.users.conversations.mockResolvedValue({
        channels: [{ id: 'C888' }],
        response_metadata: { next_cursor: '' },
      });

      mockClient.conversations.info.mockResolvedValue({
        channel: {
          id: 'C888',
          name: 'restored-name',
          unread_count: 1,
          unread_count_display: 1,
        },
      });

      const result = await channelOps.listUnreadChannels();

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: 'C888',
        name: 'restored-name',
      });
    });

    it('should resolve DM display name when the conversation has no name', async () => {
      mockClient.users.conversations.mockResolvedValue({
        channels: [
          { id: 'D999', is_im: true, user: 'U999', unread_count: 2, unread_count_display: 2 },
        ],
        response_metadata: { next_cursor: '' },
      });

      mockClient.users.info.mockResolvedValue({
        user: {
          id: 'U999',
          name: 'alice',
        },
      });

      const result = await channelOps.listUnreadChannels();

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: 'D999',
        display_name: '@alice',
        name: 'D999',
      });
      expect(mockClient.conversations.info).not.toHaveBeenCalled();
      expect(mockClient.users.info).toHaveBeenCalledWith({ user: 'U999' });
    });

    it('should fall back to user ID when DM user lookup fails', async () => {
      mockClient.users.conversations.mockResolvedValue({
        channels: [
          { id: 'D999', is_im: true, user: 'U999', unread_count: 2, unread_count_display: 2 },
        ],
        response_metadata: { next_cursor: '' },
      });
      mockClient.users.info.mockRejectedValue(new Error('missing_scope'));

      const result = await channelOps.listUnreadChannels();

      expect(result).toEqual([
        expect.objectContaining({
          id: 'D999',
          display_name: '@U999',
        }),
      ]);
    });

    it('should use MPIM purpose or channel ID as display name fallback', async () => {
      mockClient.users.conversations.mockResolvedValue({
        channels: [
          {
            id: 'G123',
            is_mpim: true,
            unread_count: 1,
            unread_count_display: 1,
            purpose: { value: ' Project Group ' },
          },
          {
            id: 'G456',
            is_mpim: true,
            unread_count: 1,
            unread_count_display: 1,
            purpose: { value: '  ' },
          },
        ],
        response_metadata: { next_cursor: '' },
      });

      const result = await channelOps.listUnreadChannels();

      expect(result[0]).toEqual(expect.objectContaining({ display_name: 'Project Group' }));
      expect(result[1]).toEqual(expect.objectContaining({ display_name: 'G456' }));
    });

    it('should sanitize resolved display names for unread conversations', async () => {
      mockClient.users.conversations.mockResolvedValue({
        channels: [
          { id: 'D999', is_im: true, user: 'U999', unread_count: 1, unread_count_display: 1 },
        ],
        response_metadata: { next_cursor: '' },
      });

      mockClient.users.info.mockResolvedValue({
        user: {
          id: 'U999',
          name: '\u001b[31malice',
        },
      });

      const result = await channelOps.listUnreadChannels();

      expect(result).toHaveLength(1);
      expect(result[0].display_name).toBe('@alice');
      expect(result[0].display_name).not.toContain('\u001b');
    });
  });

  describe('listChannels', () => {
    it('should still use conversations.list for channel listing', async () => {
      mockClient.conversations.list.mockResolvedValue({
        channels: [
          { id: 'C123', name: 'general' },
          { id: 'C456', name: 'random' },
        ],
      });

      const result = await channelOps.listChannels({
        types: 'public_channel',
        exclude_archived: true,
        limit: 100,
      });

      expect(result).toHaveLength(2);
      expect(mockClient.conversations.list).toHaveBeenCalledWith({
        types: 'public_channel',
        exclude_archived: true,
        limit: 100,
        cursor: undefined,
      });
      // Should NOT use users.conversations
      expect(mockClient.users.conversations).not.toHaveBeenCalled();
    });

    it('should handle pagination for conversations.list', async () => {
      mockClient.conversations.list
        .mockResolvedValueOnce({
          channels: [{ id: 'C001', name: 'ch1' }],
          response_metadata: { next_cursor: 'cursor2' },
        })
        .mockResolvedValueOnce({
          channels: [{ id: 'C002', name: 'ch2' }],
          response_metadata: { next_cursor: '' },
        });

      const result = await channelOps.listChannels({
        types: 'public_channel',
        exclude_archived: true,
        limit: 100,
      });

      expect(result).toHaveLength(2);
      expect(mockClient.conversations.list).toHaveBeenCalledTimes(2);
    });
  });

  describe('listChannels with member_only', () => {
    it('should use users.conversations instead of conversations.list', async () => {
      mockClient.users.conversations.mockResolvedValue({
        channels: [{ id: 'C123', name: 'general' }],
      });

      const result = await channelOps.listChannels({
        types: 'public_channel',
        exclude_archived: true,
        limit: 100,
        member_only: true,
      });

      expect(result).toEqual([{ id: 'C123', name: 'general' }]);
      expect(mockClient.users.conversations).toHaveBeenCalledWith({
        types: 'public_channel',
        exclude_archived: true,
        limit: 100,
        cursor: undefined,
      });
      expect(mockClient.conversations.list).not.toHaveBeenCalled();
    });

    it('should handle pagination for users.conversations', async () => {
      mockClient.users.conversations
        .mockResolvedValueOnce({
          channels: [{ id: 'C001', name: 'ch1' }],
          response_metadata: { next_cursor: 'cursor2' },
        })
        .mockResolvedValueOnce({
          channels: [{ id: 'C002', name: 'ch2' }],
          response_metadata: { next_cursor: '' },
        });

      const result = await channelOps.listChannels({
        types: 'public_channel',
        exclude_archived: true,
        limit: 100,
        member_only: true,
      });

      expect(result.map((channel) => channel.id)).toEqual(['C001', 'C002']);
      expect(mockClient.users.conversations).toHaveBeenNthCalledWith(2, {
        types: 'public_channel',
        exclude_archived: true,
        limit: 100,
        cursor: 'cursor2',
      });
    });
  });

  describe('countUnreadSinceLastRead', () => {
    it('should count only messages newer than last_read and omit conversations with none', async () => {
      mockClient.conversations.info.mockImplementation(
        async ({ channel }: { channel: string }) => ({
          channel:
            channel === 'D1'
              ? { id: 'D1', is_im: true, user: 'U1', last_read: '100.5' }
              : { id: 'C1', name: 'general', last_read: '300.0' },
        })
      );
      mockClient.users.info.mockResolvedValue({ user: { name: 'alice' } });

      const result = await channelOps.countUnreadSinceLastRead([
        { channel: { id: 'D1', name: 'U1', is_im: true }, timestamps: ['100.1', '100.9', '101.0'] },
        { channel: { id: 'C1', name: 'general' }, timestamps: ['200.0'] },
      ]);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ id: 'D1', user: 'U1', unread_count: 2 });
    });

    it('should omit conversations whose info lookup fails and warn on stderr', async () => {
      vi.useFakeTimers();
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      mockClient.conversations.info.mockRejectedValue(new Error('rate limit'));

      const resultPromise = channelOps.countUnreadSinceLastRead([
        { channel: { id: 'C1', name: 'general' }, timestamps: ['200.0'] },
      ]);
      await vi.advanceTimersByTimeAsync(20000);

      await expect(resultPromise).resolves.toEqual([]);
      expect(errorSpy).toHaveBeenCalledWith('Warning: skipped C1: rate limit');
      errorSpy.mockRestore();
    });
  });

  describe('getLastReads', () => {
    // @slack/web-api の errors.js が作るエラーと同じ形で作る
    // （code・retryAfter・ハイフン付きの文。Slack のエラーは data.error）
    const createRateLimitedError = (retryAfter: number) =>
      Object.assign(
        new Error(
          `A rate-limit has been reached, you may retry this request in ${retryAfter} seconds`
        ),
        { code: 'slack_webapi_rate_limited_error', retryAfter }
      );
    const createPlatformError = (error: string) =>
      Object.assign(new Error(`An API error occurred: ${error}`), {
        code: 'slack_webapi_platform_error',
        data: { ok: false, error },
      });
    const createRequestError = (message: string) =>
      Object.assign(new Error(`A request error occurred: ${message}`), {
        code: 'slack_webapi_request_error',
      });
    const createHttpError = (statusCode: number) =>
      Object.assign(new Error(`An HTTP protocol error occurred: statusCode = ${statusCode}`), {
        code: 'slack_webapi_http_error',
        statusCode,
      });

    // 呼び出しごとに、テストの側で成功・失敗させる conversations.info（完了の順序と並列数を確かめる）
    const deferInfoCalls = () => {
      const pending = new Map<
        string,
        { resolve: (value: unknown) => void; reject: (reason: unknown) => void }
      >();
      mockClient.conversations.info.mockImplementation(
        ({ channel }: { channel: string }) =>
          new Promise((resolve, reject) => {
            pending.set(channel, { resolve, reject });
          })
      );
      return pending;
    };
    // 待っている処理（タイマーではなく Promise の連鎖）を一通り進める
    const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
    const lastReadResponse = (lastRead: string) => ({ channel: { last_read: lastRead } });

    let errorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      limiterMode.useActual = true;
      errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
      limiterMode.useActual = false;
      errorSpy.mockRestore();
    });

    it('should return each last_read as Slack sent it, in input order', async () => {
      mockClient.conversations.info.mockImplementation(async ({ channel }: { channel: string }) =>
        lastReadResponse(channel === 'D2' ? '0000000000.000000' : '1759500000.123456')
      );

      const result = await channelOps.getLastReads(['C1', 'D2', 'G3']);

      // toStrictEqual: 取れた行は reason が null で、retryAfter のキーを持たない
      expect(result).toStrictEqual([
        { channelId: 'C1', lastRead: '1759500000.123456', reason: null },
        { channelId: 'D2', lastRead: '0000000000.000000', reason: null },
        { channelId: 'G3', lastRead: '1759500000.123456', reason: null },
      ]);
      expect(mockClient.conversations.info).toHaveBeenCalledTimes(3);
      expect(mockClient.conversations.info).toHaveBeenCalledWith({
        channel: 'C1',
        include_num_members: false,
      });
      // 渡された ID をそのまま使う（名前の解決で会話一覧を取りに行かない）
      expect(mockClient.conversations.list).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('should keep input order when the responses arrive in a different order', async () => {
      const pending = deferInfoCalls();

      const resultPromise = channelOps.getLastReads(['C1', 'C2', 'C3']);
      await flush();
      pending.get('C3')?.resolve(lastReadResponse('3.000000'));
      pending.get('C1')?.resolve(lastReadResponse('1.000000'));
      pending.get('C2')?.resolve(lastReadResponse('2.000000'));

      await expect(resultPromise).resolves.toStrictEqual([
        { channelId: 'C1', lastRead: '1.000000', reason: null },
        { channelId: 'C2', lastRead: '2.000000', reason: null },
        { channelId: 'C3', lastRead: '3.000000', reason: null },
      ]);
    });

    it('should call conversations.info for as many conversations at once as the unread scan', async () => {
      const limit = RATE_LIMIT.UNREAD_SCAN_CONCURRENT_REQUESTS;
      const ids = Array.from({ length: limit + 3 }, (_, i) => `C${i + 1}`);
      const pending = deferInfoCalls();

      const resultPromise = channelOps.getLastReads(ids);
      await flush();

      // 1件も終わっていない間は、並列の上限までしか呼ばない
      expect(mockClient.conversations.info).toHaveBeenCalledTimes(limit);
      for (const id of ids.slice(0, limit)) {
        pending.get(id)?.resolve(lastReadResponse('1.000000'));
      }
      await flush();
      for (const id of ids.slice(limit)) {
        pending.get(id)?.resolve(lastReadResponse('2.000000'));
      }

      const result = await resultPromise;
      expect(result.map((row) => row.channelId)).toEqual(ids);
      expect(mockClient.conversations.info).toHaveBeenCalledTimes(ids.length);
    });

    it.each([
      ['no last_read in the channel', { channel: { id: 'C2' } }],
      ['an empty last_read', { channel: { id: 'C2', last_read: '' } }],
      ['no channel in the response', {}],
    ])('should report no_last_read when the response has %s', async (_name, response) => {
      mockClient.conversations.info.mockImplementation(async ({ channel }: { channel: string }) =>
        channel === 'C2' ? response : lastReadResponse('1.000000')
      );

      const result = await channelOps.getLastReads(['C1', 'C2']);

      expect(result).toStrictEqual([
        { channelId: 'C1', lastRead: '1.000000', reason: null },
        { channelId: 'C2', lastRead: null, reason: 'no_last_read' },
      ]);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith('Warning: skipped C2: no_last_read');
    });

    it.each([
      'channel_not_found',
      'missing_scope',
    ])('should report not_visible when Slack says %s', async (slackError) => {
      mockClient.conversations.info.mockImplementation(async ({ channel }: { channel: string }) => {
        if (channel === 'C2') {
          throw createPlatformError(slackError);
        }
        return lastReadResponse('1.000000');
      });

      const result = await channelOps.getLastReads(['C1', 'C2']);

      expect(result).toStrictEqual([
        { channelId: 'C1', lastRead: '1.000000', reason: null },
        { channelId: 'C2', lastRead: null, reason: 'not_visible' },
      ]);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith(
        `Warning: skipped C2: not_visible (An API error occurred: ${slackError})`
      );
    });

    it.each([
      ['another Slack error', createPlatformError('internal_error')],
      ['a request failure', createRequestError('getaddrinfo ENOTFOUND slack.com')],
      ['an HTTP failure', createHttpError(500)],
      ['an error without a code', new Error('boom')],
      // 文に「rate limit」とあっても、code が回数制限でなければ回数制限として扱わない
      ['an old-style rate limit sentence without the code', new Error('rate limit')],
    ])('should report error for %s without retrying', async (_name, failure) => {
      mockClient.conversations.info.mockImplementation(async ({ channel }: { channel: string }) => {
        if (channel === 'C2') {
          throw failure;
        }
        return lastReadResponse('1.000000');
      });

      const result = await channelOps.getLastReads(['C1', 'C2']);

      expect(result).toStrictEqual([
        { channelId: 'C1', lastRead: '1.000000', reason: null },
        { channelId: 'C2', lastRead: null, reason: 'error' },
      ]);
      // 再試行しない（C2 への呼び出しは1回だけ）
      expect(mockClient.conversations.info).toHaveBeenCalledTimes(2);
      expect(errorSpy).toHaveBeenCalledWith(`Warning: skipped C2: error (${failure.message})`);
    });

    it('should report rate_limited with retryAfter without retrying or waiting', async () => {
      // タイマーは進めない。待つ処理があれば結果が返らず、テストが時間切れになる
      vi.useFakeTimers();
      mockClient.conversations.info.mockRejectedValue(createRateLimitedError(45));

      const result = await channelOps.getLastReads(['C1']);

      expect(result).toStrictEqual([
        { channelId: 'C1', lastRead: null, reason: 'rate_limited', retryAfter: 45 },
      ]);
      expect(mockClient.conversations.info).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith(
        'Warning: skipped C1: rate_limited (A rate-limit has been reached, you may retry this request in 45 seconds)'
      );
    });

    it('should not call conversations.info for conversations not yet requested once one is rate limited', async () => {
      const limit = RATE_LIMIT.UNREAD_SCAN_CONCURRENT_REQUESTS;
      const ids = Array.from({ length: limit + 5 }, (_, i) => `C${String(i + 1).padStart(2, '0')}`);
      const inFlight = ids.slice(0, limit);
      const notYetRequested = ids.slice(limit);
      const pending = deferInfoCalls();

      const resultPromise = channelOps.getLastReads(ids);
      await flush();
      expect(mockClient.conversations.info).toHaveBeenCalledTimes(limit);

      // 呼び出し中の1件が回数制限になり、そのあとで残りの呼び出し中の分が終わる
      pending.get('C05')?.reject(createRateLimitedError(45));
      await flush();
      for (const id of inFlight.filter((id) => id !== 'C05')) {
        pending.get(id)?.resolve(lastReadResponse('100.000000'));
      }
      await flush();

      // まだ呼んでいなかった会話は呼ばない（呼ぶ実装だと、ここで呼び出しが増えて失敗する）
      expect(mockClient.conversations.info).toHaveBeenCalledTimes(limit);
      const result = await resultPromise;
      expect(result.map((row) => row.channelId)).toEqual(ids);
      // すでに呼んでいた会話は、成功した分の lastRead を保つ
      for (const row of result.slice(0, limit)) {
        if (row.channelId === 'C05') {
          expect(row).toStrictEqual({
            channelId: 'C05',
            lastRead: null,
            reason: 'rate_limited',
            retryAfter: 45,
          });
        } else {
          expect(row).toStrictEqual({
            channelId: row.channelId,
            lastRead: '100.000000',
            reason: null,
          });
        }
      }
      // 呼ばなかった会話は rate_limited で、最初に受けた回数制限の秒数を持つ
      expect(result.slice(limit)).toStrictEqual(
        notYetRequested.map((channelId) => ({
          channelId,
          lastRead: null,
          reason: 'rate_limited',
          retryAfter: 45,
        }))
      );
      expect(errorSpy).toHaveBeenCalledWith(
        `Warning: skipped ${notYetRequested[0]}: rate_limited (not requested after an earlier rate limit, retry after 45 seconds)`
      );
    });

    it('should keep the retryAfter of its own response for each rate limited conversation', async () => {
      const pending = deferInfoCalls();

      const resultPromise = channelOps.getLastReads(['C1', 'C2', 'C3']);
      await flush();
      pending.get('C1')?.reject(createRateLimitedError(45));
      pending.get('C2')?.reject(createRateLimitedError(60));
      pending.get('C3')?.resolve(lastReadResponse('3.000000'));

      await expect(resultPromise).resolves.toStrictEqual([
        { channelId: 'C1', lastRead: null, reason: 'rate_limited', retryAfter: 45 },
        { channelId: 'C2', lastRead: null, reason: 'rate_limited', retryAfter: 60 },
        { channelId: 'C3', lastRead: '3.000000', reason: null },
      ]);
    });

    it.each([
      'invalid_auth',
      'not_authed',
      'token_revoked',
      'token_expired',
      'account_inactive',
    ])('should reject as a whole when Slack says %s', async (slackError) => {
      mockClient.conversations.info.mockImplementation(async ({ channel }: { channel: string }) => {
        if (channel === 'C2') {
          throw createPlatformError(slackError);
        }
        return lastReadResponse('1.000000');
      });

      await expect(channelOps.getLastReads(['C1', 'C2', 'C3'])).rejects.toThrow(
        `An API error occurred: ${slackError}`
      );
      // 会話ごとの警告は出さない
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('should stop calling conversations.info for conversations not yet requested once authentication fails', async () => {
      const limit = RATE_LIMIT.UNREAD_SCAN_CONCURRENT_REQUESTS;
      const ids = Array.from({ length: limit + 3 }, (_, i) => `C${String(i + 1).padStart(2, '0')}`);
      const pending = deferInfoCalls();

      const resultPromise = channelOps.getLastReads(ids);
      const rejection = expect(resultPromise).rejects.toThrow(
        'An API error occurred: token_expired'
      );
      await flush();
      expect(mockClient.conversations.info).toHaveBeenCalledTimes(limit);

      pending.get('C01')?.reject(createPlatformError('token_expired'));
      await flush();
      for (const id of ids.slice(1, limit)) {
        pending.get(id)?.resolve(lastReadResponse('1.000000'));
      }
      await rejection;
      await flush();

      expect(mockClient.conversations.info).toHaveBeenCalledTimes(limit);
    });

    it('should print one warning per unreadable conversation in input order after all calls finish', async () => {
      const pending = deferInfoCalls();

      const resultPromise = channelOps.getLastReads(['C1', 'C2', 'C3', 'C4']);
      await flush();
      // 入力と逆の順に終わらせる
      pending.get('C4')?.reject(createRequestError('connect ECONNREFUSED'));
      await flush();
      pending.get('C3')?.reject(createPlatformError('channel_not_found'));
      await flush();
      pending.get('C2')?.resolve({ channel: { id: 'C2' } });
      await flush();
      expect(errorSpy).not.toHaveBeenCalled();
      pending.get('C1')?.resolve(lastReadResponse('1.000000'));
      await resultPromise;

      expect(errorSpy.mock.calls).toEqual([
        ['Warning: skipped C2: no_last_read'],
        ['Warning: skipped C3: not_visible (An API error occurred: channel_not_found)'],
        ['Warning: skipped C4: error (A request error occurred: connect ECONNREFUSED)'],
      ]);
    });

    describe('with the errors @slack/web-api itself builds', () => {
      // 手で作ったエラーの形が、ライブラリが実際に作る形からずれても、ここで気づけるようにする
      const getLastReadsFailing = async (failure: Error) => {
        mockClient.conversations.info.mockRejectedValue(failure);
        return channelOps.getLastReads(['C1']);
      };

      it('should classify a rate limit by its code and read retryAfter', async () => {
        await expect(
          getLastReadsFailing(slackErrors.rateLimitedErrorWithDelay(45))
        ).resolves.toStrictEqual([
          { channelId: 'C1', lastRead: null, reason: 'rate_limited', retryAfter: 45 },
        ]);
      });

      it('should classify Slack errors by data.error', async () => {
        await expect(
          getLastReadsFailing(
            slackErrors.platformErrorFromResult({ ok: false, error: 'channel_not_found' })
          )
        ).resolves.toStrictEqual([{ channelId: 'C1', lastRead: null, reason: 'not_visible' }]);
        await expect(
          getLastReadsFailing(slackErrors.platformErrorFromResult({ ok: false, error: 'oops' }))
        ).resolves.toStrictEqual([{ channelId: 'C1', lastRead: null, reason: 'error' }]);
        await expect(
          getLastReadsFailing(
            slackErrors.platformErrorFromResult({ ok: false, error: 'token_expired' })
          )
        ).rejects.toThrow('An API error occurred: token_expired');
      });

      it('should classify request and HTTP failures as error', async () => {
        await expect(
          getLastReadsFailing(
            slackErrors.requestErrorWithOriginal(new Error('connect ECONNREFUSED'), false)
          )
        ).resolves.toStrictEqual([{ channelId: 'C1', lastRead: null, reason: 'error' }]);
        await expect(
          getLastReadsFailing(
            slackErrors.httpErrorFromResponse({
              status: 500,
              statusText: 'Internal Server Error',
              headers: {},
              data: {},
            } as never)
          )
        ).resolves.toStrictEqual([{ channelId: 'C1', lastRead: null, reason: 'error' }]);
      });
    });
  });

  describe('getChannelInfo', () => {
    it('should resolve names and fetch channel info without member counts', async () => {
      mockClient.conversations.list.mockResolvedValue({
        channels: [{ id: 'C123', name: 'general' }],
        response_metadata: { next_cursor: '' },
      });
      mockClient.conversations.info.mockResolvedValue({
        channel: { id: 'C123', name: 'general' },
      });

      await expect(channelOps.getChannelInfo('general')).resolves.toEqual({
        id: 'C123',
        name: 'general',
      });
      expect(mockClient.conversations.info).toHaveBeenCalledWith({
        channel: 'C123',
      });
    });
  });
});
