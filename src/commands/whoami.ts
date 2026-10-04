import type { AuthTestResponse } from '@slack/web-api';
import { Command } from 'commander';
import type { WhoamiOptions } from '../types/commands';
import { withSlackClient } from '../utils/command-support';
import { wrapCommand } from '../utils/command-wrapper';
import { ApiError } from '../utils/errors';
import { sanitizeTerminalData, sanitizeTerminalText } from '../utils/terminal-sanitizer';
import { createValidationHook } from '../utils/validators';

// 出力する5項目。auth.test の応答からこの5つだけを取り出し、トークンも、ほかの項目も出さない。
// 項目名は呼び出し側のプログラム（Slack Hub）が読むので、変えない
interface WhoamiResult {
  userId: string;
  user: string;
  teamId: string;
  team: string;
  url: string;
}

function toWhoamiResult(response: AuthTestResponse): WhoamiResult {
  // ボットのトークンの応答には bot_id が付く。ユーザーの情報としては使えないので、先に失敗にする
  if (response.bot_id) {
    throw new ApiError('The token is not a user token (auth.test returned a bot_id)');
  }
  if (!response.user_id || !response.team_id) {
    throw new ApiError('auth.test did not return user_id and team_id');
  }

  // user・team・url が応答に無いときは空文字にして、出力の5項目をいつも文字列にそろえる
  return {
    userId: response.user_id,
    user: response.user ?? '',
    teamId: response.team_id,
    team: response.team ?? '',
    url: response.url ?? '',
  };
}

function renderWhoamiText(result: WhoamiResult): void {
  const user = sanitizeTerminalText(result.user);
  const userId = sanitizeTerminalText(result.userId);
  const team = sanitizeTerminalText(result.team);
  const teamId = sanitizeTerminalText(result.teamId);

  console.log(`User:      ${user} (${userId})`);
  console.log(`Workspace: ${team} (${teamId})`);
  console.log(`URL:       ${sanitizeTerminalText(result.url)}`);
}

// whoami には表の出力が無いので、text と json だけを通す
function validateWhoamiFormat(options: Record<string, unknown>): string | null {
  const validFormats = ['text', 'json'];
  if (options.format !== undefined && !validFormats.includes(options.format as string)) {
    return `Invalid format '${options.format}'. Must be one of: ${validFormats.join(', ')}`;
  }
  return null;
}

export function setupWhoamiCommand(): Command {
  return new Command('whoami')
    .description('Show the user and workspace the token belongs to')
    .option('--format <format>', 'Output format: text, json', 'text')
    .option('--profile <profile>', 'Use specific workspace profile')
    .hook('preAction', createValidationHook([validateWhoamiFormat]))
    .action(
      wrapCommand(async (options: WhoamiOptions) => {
        await withSlackClient(options, async (client) => {
          const result = toWhoamiResult(await client.testAuth());

          if (options.format === 'json') {
            console.log(JSON.stringify(sanitizeTerminalData(result), null, 2));
            return;
          }

          renderWhoamiText(result);
        });
      })
    );
}
