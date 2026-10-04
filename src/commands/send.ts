import chalk from 'chalk';
import { Command } from 'commander';
import * as fs from 'fs/promises';
import { SendOptions } from '../types/commands';
import type { SlackMessageBlock } from '../types/slack';
import { createSlackClient } from '../utils/client-factory';
import { wrapCommand } from '../utils/command-wrapper';
import { ERROR_MESSAGES, SUCCESS_MESSAGES } from '../utils/constants';
import { extractErrorMessage } from '../utils/error-utils';
import { FileError, ValidationError } from '../utils/errors';
import { parseProfile } from '../utils/option-parsers';
import { resolvePostAt } from '../utils/schedule-utils';
import { sanitizeTerminalData } from '../utils/terminal-sanitizer';
import { createValidationHook, optionValidators } from '../utils/validators';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseBlocksJson(blocksJson: string): SlackMessageBlock[] {
  let parsed: unknown;

  try {
    parsed = JSON.parse(blocksJson);
  } catch {
    throw new ValidationError(ERROR_MESSAGES.INVALID_BLOCKS_JSON);
  }

  if (!Array.isArray(parsed)) {
    throw new ValidationError(ERROR_MESSAGES.INVALID_BLOCKS_SHAPE);
  }

  const hasInvalidBlock = parsed.some(
    (block) => !isRecord(block) || typeof block.type !== 'string' || block.type.trim() === ''
  );

  if (hasInvalidBlock) {
    throw new ValidationError(ERROR_MESSAGES.INVALID_BLOCK_SHAPE);
  }

  return parsed as SlackMessageBlock[];
}

async function readBlocks(options: SendOptions): Promise<SlackMessageBlock[] | undefined> {
  if (options.blocks !== undefined) {
    return parseBlocksJson(options.blocks);
  }

  if (!options.blocksFile) {
    return undefined;
  }

  try {
    const blocksJson = await fs.readFile(options.blocksFile, 'utf-8');
    return parseBlocksJson(blocksJson);
  } catch (error) {
    if (error instanceof ValidationError) {
      throw error;
    }

    throw new FileError(
      ERROR_MESSAGES.FILE_READ_ERROR(options.blocksFile, extractErrorMessage(error))
    );
  }
}

// --format json 用の機械可読な結果。呼び出し側が投稿の位置を特定するために使う。
interface SentJsonResult {
  ok: true;
  channelId: string;
  ts: string | null;
  threadTs: string | null;
}

interface ScheduledJsonResult {
  ok: true;
  scheduled: true;
  channelId: string;
  scheduledMessageId: string | null;
  postAt: number;
}

function printJson(result: SentJsonResult | ScheduledJsonResult): void {
  console.log(JSON.stringify(sanitizeTerminalData(result), null, 2));
}

export function setupSendCommand(): Command {
  const sendCommand = new Command('send')
    .description('Send or schedule a message to a Slack channel or DM')
    .option('-c, --channel <channel>', 'Target channel name or ID')
    .option('--user <username>', 'Send DM to user by username')
    .option('--user-id <userId>', 'Send DM to user by Slack user ID')
    .option('--email <email>', 'Send DM to user by email address')
    .option('-m, --message <message>', 'Message to send')
    .option('-f, --file <file>', 'File containing message content')
    .option('--blocks <json>', 'Block Kit blocks as a JSON array')
    .option('--blocks-file <file>', 'File containing Block Kit blocks JSON')
    .option('-t, --thread <thread>', 'Thread timestamp to reply to')
    .option('--at <time>', 'Schedule time (Unix timestamp in seconds or ISO 8601)')
    .option('--after <minutes>', 'Schedule message after N minutes')
    .option('--format <format>', 'Output format: text, json', 'text')
    .option('--profile <profile>', 'Use specific workspace profile')
    .hook(
      'preAction',
      createValidationHook([
        optionValidators.sendUserId,
        optionValidators.sendTarget,
        optionValidators.messageOrFile,
        optionValidators.threadTimestamp,
        optionValidators.scheduleTiming,
        optionValidators.sendFormat,
      ])
    )
    .action(
      wrapCommand(async (options: SendOptions) => {
        // Get message content
        let messageContent: string | undefined;
        if (options.file) {
          try {
            messageContent = await fs.readFile(options.file, 'utf-8');
          } catch (error) {
            throw new FileError(
              ERROR_MESSAGES.FILE_READ_ERROR(options.file, extractErrorMessage(error))
            );
          }
        } else {
          messageContent = options.message;
        }

        const blocks = await readBlocks(options);
        const postAt = resolvePostAt(options.at, options.after);

        // Send message
        const profile = parseProfile(options.profile);
        const client = await createSlackClient(profile);

        // Resolve target channel
        let targetChannel: string;
        let targetLabel: string;
        const isDm = Boolean(options.user || options.email || options.userId);

        if (options.user) {
          const userId = await client.resolveUserIdByName(options.user);
          targetChannel = await client.openDmChannel(userId);
          targetLabel = `@${options.user.replace(/^@/, '')}`;
        } else if (options.email) {
          const user = await client.lookupUserByEmail(options.email);
          targetChannel = await client.openDmChannel(user.id!);
          targetLabel = options.email;
        } else if (options.userId) {
          // ID が分かっているので、users.list を走査せずに DM を直接開く。
          targetChannel = await client.openDmChannel(options.userId);
          targetLabel = options.userId;
        } else {
          targetChannel = options.channel!;
          targetLabel = `#${options.channel}`;
        }

        if (postAt !== null) {
          const scheduled = await client.scheduleMessage(
            targetChannel,
            messageContent,
            postAt,
            options.thread,
            blocks
          );

          if (options.format === 'json') {
            // 応答は optional chaining で読む。API 呼び出しのあとで例外を投げると、
            // 受理済みの送信を呼び出し側が失敗と見なしてしまう。
            printJson({
              ok: true,
              scheduled: true,
              channelId: scheduled?.channel ?? targetChannel,
              scheduledMessageId: scheduled?.scheduled_message_id ?? null,
              postAt: scheduled?.post_at ?? postAt,
            });
            return;
          }

          const postAtIso = new Date(postAt * 1000).toISOString();
          if (isDm) {
            console.log(chalk.green(`✓ Message scheduled to ${targetLabel} at ${postAtIso}`));
          } else {
            console.log(
              chalk.green(`✓ ${SUCCESS_MESSAGES.MESSAGE_SCHEDULED(options.channel!, postAtIso)}`)
            );
          }
          return;
        }

        const sent = await client.sendMessage(
          targetChannel,
          messageContent,
          options.thread,
          blocks
        );

        if (options.format === 'json') {
          // 予約の分岐と同じ理由で、API 呼び出しのあとで例外を投げてはいけない。
          printJson({
            ok: true,
            channelId: sent?.channel ?? targetChannel,
            ts: sent?.ts ?? null,
            threadTs: options.thread ?? null,
          });
          return;
        }

        if (isDm) {
          console.log(chalk.green(`✓ DM sent to ${targetLabel}`));
        } else {
          console.log(chalk.green(`✓ ${SUCCESS_MESSAGES.MESSAGE_SENT(options.channel!)}`));
        }
      })
    );

  return sendCommand;
}
