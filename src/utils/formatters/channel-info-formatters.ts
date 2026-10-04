import chalk from 'chalk';
import { ChannelDetail, ChannelLastRead } from '../../types/slack';
import { sanitizeTerminalText } from '../terminal-sanitizer';
import { AbstractFormatter, createFormatterFactory, JsonFormatter } from './base-formatter';

export interface ChannelInfoFormatterOptions {
  channel: ChannelDetail;
}

class TableChannelInfoFormatter extends AbstractFormatter<ChannelInfoFormatterOptions> {
  format(options: ChannelInfoFormatterOptions): void {
    const { channel } = options;
    const name = sanitizeTerminalText(channel.name);
    const topic = sanitizeTerminalText(channel.topic?.value || '(not set)');
    const purpose = sanitizeTerminalText(channel.purpose?.value || '(not set)');

    console.log(chalk.bold(`\nChannel Info: #${name}`));
    console.log('');
    console.log(`  ${chalk.gray('ID:')}       ${channel.id}`);
    console.log(`  ${chalk.gray('Name:')}     ${name}`);
    console.log(`  ${chalk.gray('Private:')}  ${channel.is_private ? 'Yes' : 'No'}`);
    console.log(`  ${chalk.gray('Archived:')} ${channel.is_archived ? 'Yes' : 'No'}`);
    if (channel.num_members !== undefined) {
      console.log(`  ${chalk.gray('Members:')}  ${channel.num_members}`);
    }
    console.log(
      `  ${chalk.gray('Created:')}  ${new Date(channel.created * 1000).toLocaleDateString()}`
    );
    console.log('');
    console.log(`  ${chalk.gray('Topic:')}    ${topic}`);
    console.log(`  ${chalk.gray('Purpose:')}  ${purpose}`);
    console.log('');
  }
}

class SimpleChannelInfoFormatter extends AbstractFormatter<ChannelInfoFormatterOptions> {
  format(options: ChannelInfoFormatterOptions): void {
    const { channel } = options;
    const name = sanitizeTerminalText(channel.name);
    const topic = sanitizeTerminalText(channel.topic?.value || '(not set)');
    const purpose = sanitizeTerminalText(channel.purpose?.value || '(not set)');

    console.log(`${name} (${channel.id})`);
    console.log(`Topic: ${topic}`);
    console.log(`Purpose: ${purpose}`);
    if (channel.num_members !== undefined) {
      console.log(`Members: ${channel.num_members}`);
    }
  }
}

class JsonChannelInfoFormatter extends JsonFormatter<ChannelInfoFormatterOptions> {
  protected transform(options: ChannelInfoFormatterOptions) {
    const { channel } = options;
    return {
      id: channel.id,
      name: channel.name,
      is_private: channel.is_private,
      is_archived: channel.is_archived ?? false,
      created: channel.created,
      num_members: channel.num_members,
      topic: channel.topic?.value || null,
      purpose: channel.purpose?.value || null,
    };
  }
}

const channelInfoFormatterFactory = createFormatterFactory<ChannelInfoFormatterOptions>({
  table: new TableChannelInfoFormatter(),
  simple: new SimpleChannelInfoFormatter(),
  json: new JsonChannelInfoFormatter(),
});

export function createChannelInfoFormatter(format: string) {
  return channelInfoFormatterFactory.create(format);
}

export interface LastReadFormatterOptions {
  results: ChannelLastRead[];
}

// 取れなかった理由の表示。回数制限のときは待つ秒数も添える
function describeLastReadReason({ reason, retryAfter }: ChannelLastRead): string {
  if (reason === null) {
    return '-';
  }
  return reason === 'rate_limited' && retryAfter !== undefined
    ? `${reason}, retry after ${retryAfter}s`
    : reason;
}

const LAST_READ_CHANNEL_COLUMN_WIDTH = 12;
const LAST_READ_TIMESTAMP_COLUMN_WIDTH = 17;

class TableLastReadFormatter extends AbstractFormatter<LastReadFormatterOptions> {
  format({ results }: LastReadFormatterOptions): void {
    const pad = (value: string, width: number) => value.padEnd(width);
    console.log(
      chalk.bold(
        `${pad('Channel', LAST_READ_CHANNEL_COLUMN_WIDTH)}  ${pad('Last Read', LAST_READ_TIMESTAMP_COLUMN_WIDTH)}  Reason`
      )
    );
    console.log('─'.repeat(60));

    for (const row of results) {
      const channelId = pad(sanitizeTerminalText(row.channelId), LAST_READ_CHANNEL_COLUMN_WIDTH);
      const lastRead = pad(row.lastRead ?? '-', LAST_READ_TIMESTAMP_COLUMN_WIDTH);
      console.log(`${channelId}  ${lastRead}  ${describeLastReadReason(row)}`);
    }
  }
}

class SimpleLastReadFormatter extends AbstractFormatter<LastReadFormatterOptions> {
  format({ results }: LastReadFormatterOptions): void {
    for (const row of results) {
      const channelId = sanitizeTerminalText(row.channelId);
      console.log(
        row.lastRead !== null
          ? `${channelId}: ${row.lastRead}`
          : `${channelId}: - (${describeLastReadReason(row)})`
      );
    }
  }
}

class JsonLastReadFormatter extends JsonFormatter<LastReadFormatterOptions> {
  protected transform({ results }: LastReadFormatterOptions) {
    // 取れた行も reason を null で出す。retryAfter は rate_limited の行だけに付ける
    return results.map(({ channelId, lastRead, reason, retryAfter }) => ({
      channelId,
      lastRead,
      reason,
      ...(retryAfter !== undefined && { retryAfter }),
    }));
  }
}

const lastReadFormatterFactory = createFormatterFactory<LastReadFormatterOptions>({
  table: new TableLastReadFormatter(),
  simple: new SimpleLastReadFormatter(),
  json: new JsonLastReadFormatter(),
});

export function createLastReadFormatter(format: string) {
  return lastReadFormatterFactory.create(format);
}
