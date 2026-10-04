import { Command } from 'commander';
import {
  ChannelInfoOptions,
  ChannelLastReadOptions,
  ChannelSetPurposeOptions,
  ChannelSetTopicOptions,
} from '../types/commands';
import { createSlackClient } from '../utils/client-factory';
import { wrapCommand } from '../utils/command-wrapper';
import {
  createChannelInfoFormatter,
  createLastReadFormatter,
} from '../utils/formatters/channel-info-formatters';
import { parseFormat, parseProfile } from '../utils/option-parsers';
import { createValidationHook, optionValidators } from '../utils/validators';

async function handleLastRead(options: ChannelLastReadOptions): Promise<void> {
  const profile = parseProfile(options.profile);
  // 呼び出し側のプログラムが読む出力なので、回数制限に当たったら retry-after を待たず、すぐ失敗させる。
  // 会話ごとの理由（rate_limited など）は出力に載せ、全体の失敗（認証など）だけがエラー終了になる
  const client = await createSlackClient(profile, { rejectRateLimitedCalls: true });

  const results = await client.getLastReads(options.ids);
  const format = parseFormat(options.format);
  const formatter = createLastReadFormatter(format);
  formatter.format({ results });
}

export function setupChannelCommand(): Command {
  const channelCommand = new Command('channel').description(
    'Manage channel topic, purpose, and info'
  );

  channelCommand
    .command('info')
    .description('Display channel details including topic and purpose')
    .requiredOption('-c, --channel <channel>', 'Target channel name or ID')
    .option('--format <format>', 'Output format: table, simple, json', 'table')
    .option('--profile <profile>', 'Use specific workspace profile')
    .hook('preAction', createValidationHook([optionValidators.format]))
    .action(
      wrapCommand(async (options: ChannelInfoOptions) => {
        const profile = parseProfile(options.profile);
        const client = await createSlackClient(profile);

        const channel = await client.getChannelDetail(options.channel);
        const format = parseFormat(options.format);
        const formatter = createChannelInfoFormatter(format);
        formatter.format({ channel });
      })
    );

  channelCommand
    .command('last-read')
    .description("Print each conversation's last_read position, in the order given")
    .argument('<ids...>', 'Conversation IDs (e.g. C0123456789 D0123456789)')
    .option('--format <format>', 'Output format: table, simple, json', 'table')
    .option('--profile <profile>', 'Use specific workspace profile')
    .addHelpText(
      'after',
      [
        '',
        'Never retries and fails at once on a rate limit. A conversation whose last_read',
        'could not be read is printed with lastRead null and one of these reasons:',
        '  no_last_read   the response has no last_read (e.g. a channel you have not joined)',
        '  not_visible    channel_not_found or missing_scope',
        '  rate_limited   rate limited (retryAfter holds the seconds to wait); conversations',
        '                 not yet requested are not requested and get this reason too',
        '  error          any other Slack error, or a network/HTTP failure',
        'Authentication failures (invalid_auth, token_expired, ...) fail the whole command.',
      ].join('\n')
    )
    .hook('preAction', createValidationHook([optionValidators.format]))
    .action((ids: string[], options: Omit<ChannelLastReadOptions, 'ids'>) =>
      // wrapCommand は第1引数しか渡さないので、位置引数の ids を options にまとめる
      wrapCommand(handleLastRead)({ ...options, ids })
    );

  channelCommand
    .command('set-topic')
    .description('Set the topic of a channel')
    .requiredOption('-c, --channel <channel>', 'Target channel name or ID')
    .requiredOption('--topic <topic>', 'New topic text')
    .option('--profile <profile>', 'Use specific workspace profile')
    .action(
      wrapCommand(async (options: ChannelSetTopicOptions) => {
        const profile = parseProfile(options.profile);
        const client = await createSlackClient(profile);

        await client.setTopic(options.channel, options.topic);
        console.log(`✓ Topic updated for #${options.channel}`);
      })
    );

  channelCommand
    .command('set-purpose')
    .description('Set the purpose of a channel')
    .requiredOption('-c, --channel <channel>', 'Target channel name or ID')
    .requiredOption('--purpose <purpose>', 'New purpose text')
    .option('--profile <profile>', 'Use specific workspace profile')
    .action(
      wrapCommand(async (options: ChannelSetPurposeOptions) => {
        const profile = parseProfile(options.profile);
        const client = await createSlackClient(profile);

        await client.setPurpose(options.channel, options.purpose);
        console.log(`✓ Purpose updated for #${options.channel}`);
      })
    );

  return channelCommand;
}
