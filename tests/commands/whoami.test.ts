import type { AuthTestResponse } from '@slack/web-api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupWhoamiCommand } from '../../src/commands/whoami';
import { ProfileConfigManager } from '../../src/utils/profile-config';
import { SlackApiClient } from '../../src/utils/slack-api-client';
import { createTestProgram, restoreMocks, setupMockConsole } from '../test-utils';

vi.mock('../../src/utils/slack-api-client');
vi.mock('../../src/utils/profile-config');

// 設定に保存されているトークンのダミー。どの出力にも現れてはいけない
const TOKEN = 'xoxp-test-token';

// ユーザートークンのときの auth.test の応答
const USER_RESPONSE: AuthTestResponse = {
  ok: true,
  url: 'https://example.slack.com/',
  team: 'Example Team',
  user: 'alice',
  team_id: 'T1234567890',
  user_id: 'U1234567890',
};

// トークンが混ざった応答。Slack は auth.test の応答にトークンを入れないが、応答をそのまま、
// またはエラーメッセージに入れて出してしまう変更があっても、トークンは出力に出ないことを確かめる
const RESPONSE_WITH_TOKEN = { ...USER_RESPONSE, token: TOKEN };

const EXPECTED_JSON = {
  userId: 'U1234567890',
  user: 'alice',
  teamId: 'T1234567890',
  team: 'Example Team',
  url: 'https://example.slack.com/',
};

describe('whoami command', () => {
  let program: ReturnType<typeof createTestProgram>;
  let mockSlackClient: SlackApiClient;
  let mockConfigManager: ProfileConfigManager;
  let mockConsole: ReturnType<typeof setupMockConsole>;

  // 標準出力（console.log）と標準エラー（console.error）に出た文字列を、すべてつなげて返す
  function printedText(): string {
    return [...mockConsole.logSpy.mock.calls, ...mockConsole.errorSpy.mock.calls]
      .flat()
      .map((arg) => String(arg))
      .join('\n');
  }

  beforeEach(() => {
    vi.clearAllMocks();

    mockConfigManager = new ProfileConfigManager();
    vi.mocked(ProfileConfigManager).mockImplementation(function () {
      return mockConfigManager;
    });
    vi.mocked(mockConfigManager.getConfig).mockResolvedValue({
      token: TOKEN,
      updatedAt: new Date().toISOString(),
    });

    mockSlackClient = new SlackApiClient('setup-only');
    vi.mocked(SlackApiClient).mockImplementation(function () {
      return mockSlackClient;
    });
    // 上の new は準備のための呼び出し。コマンドが作った回数と引数だけを見られるよう、履歴を消す
    vi.mocked(SlackApiClient).mockClear();

    mockConsole = setupMockConsole();
    program = createTestProgram();
    program.addCommand(setupWhoamiCommand());
  });

  afterEach(() => {
    restoreMocks();
  });

  describe('--format json', () => {
    it('should print userId, user, teamId, team and url', async () => {
      vi.mocked(mockSlackClient.testAuth).mockResolvedValue(USER_RESPONSE);

      await program.parseAsync(['node', 'slack-cli', 'whoami', '--format', 'json']);

      expect(mockConsole.logSpy).toHaveBeenCalledTimes(1);
      const output = JSON.parse(mockConsole.logSpy.mock.calls[0][0] as string);
      expect(output).toEqual(EXPECTED_JSON);
      expect(Object.keys(output)).toEqual(['userId', 'user', 'teamId', 'team', 'url']);
      expect(mockConsole.errorSpy).not.toHaveBeenCalled();
      expect(mockConsole.exitSpy).not.toHaveBeenCalled();
    });

    it('should not pass through other fields of the auth.test response', async () => {
      vi.mocked(mockSlackClient.testAuth).mockResolvedValue({
        ...RESPONSE_WITH_TOKEN,
        enterprise_id: 'E1234567890',
        is_enterprise_install: false,
      });

      await program.parseAsync(['node', 'slack-cli', 'whoami', '--format', 'json']);

      const output = JSON.parse(mockConsole.logSpy.mock.calls[0][0] as string);
      expect(output).toEqual(EXPECTED_JSON);
      expect(Object.keys(output)).toEqual(['userId', 'user', 'teamId', 'team', 'url']);
      expect(printedText()).not.toMatch(/xox/i);
    });

    it('should print an empty string for user, team and url that auth.test did not return', async () => {
      vi.mocked(mockSlackClient.testAuth).mockResolvedValue({
        ok: true,
        team_id: 'T1234567890',
        user_id: 'U1234567890',
      });

      await program.parseAsync(['node', 'slack-cli', 'whoami', '--format', 'json']);

      expect(JSON.parse(mockConsole.logSpy.mock.calls[0][0] as string)).toEqual({
        userId: 'U1234567890',
        user: '',
        teamId: 'T1234567890',
        team: '',
        url: '',
      });
      expect(mockConsole.exitSpy).not.toHaveBeenCalled();
    });

    it('should strip terminal control sequences from the values', async () => {
      vi.mocked(mockSlackClient.testAuth).mockResolvedValue({
        ...USER_RESPONSE,
        user: 'ali\u001b[31mce',
      });

      await program.parseAsync(['node', 'slack-cli', 'whoami', '--format', 'json']);

      expect(JSON.parse(mockConsole.logSpy.mock.calls[0][0] as string).user).toBe('alice');
    });
  });

  describe('--format text', () => {
    const expectedLines = [
      'User:      alice (U1234567890)',
      'Workspace: Example Team (T1234567890)',
      'URL:       https://example.slack.com/',
    ];

    it('should print the user, the workspace and the URL by default', async () => {
      vi.mocked(mockSlackClient.testAuth).mockResolvedValue(USER_RESPONSE);

      await program.parseAsync(['node', 'slack-cli', 'whoami']);

      expect(mockConsole.logSpy.mock.calls.map((call) => call[0])).toEqual(expectedLines);
      expect(mockConsole.errorSpy).not.toHaveBeenCalled();
      expect(mockConsole.exitSpy).not.toHaveBeenCalled();
    });

    it('should print the same lines with an explicit --format text', async () => {
      vi.mocked(mockSlackClient.testAuth).mockResolvedValue(USER_RESPONSE);

      await program.parseAsync(['node', 'slack-cli', 'whoami', '--format', 'text']);

      expect(mockConsole.logSpy.mock.calls.map((call) => call[0])).toEqual(expectedLines);
    });

    it('should strip terminal control sequences from the values', async () => {
      vi.mocked(mockSlackClient.testAuth).mockResolvedValue({
        ...USER_RESPONSE,
        user: 'ali\u001b[31mce',
      });

      await program.parseAsync(['node', 'slack-cli', 'whoami']);

      expect(mockConsole.logSpy.mock.calls[0][0]).toBe('User:      alice (U1234567890)');
    });
  });

  describe('the token is never printed', () => {
    type Scenario = {
      name: string;
      args: string[];
      arrange: (client: SlackApiClient) => void;
    };

    const scenarios: Scenario[] = [
      {
        name: 'text output',
        args: ['whoami'],
        arrange: (client) => vi.mocked(client.testAuth).mockResolvedValue(RESPONSE_WITH_TOKEN),
      },
      {
        name: 'json output',
        args: ['whoami', '--format', 'json'],
        arrange: (client) => vi.mocked(client.testAuth).mockResolvedValue(RESPONSE_WITH_TOKEN),
      },
      {
        name: 'a bot token',
        args: ['whoami'],
        arrange: (client) =>
          vi
            .mocked(client.testAuth)
            .mockResolvedValue({ ...RESPONSE_WITH_TOKEN, bot_id: 'B1234567890' }),
      },
      {
        name: 'an auth.test failure',
        args: ['whoami', '--format', 'json'],
        arrange: (client) =>
          vi
            .mocked(client.testAuth)
            .mockRejectedValue(new Error('An API error occurred: invalid_auth')),
      },
      {
        name: 'a response without user_id',
        args: ['whoami'],
        arrange: (client) =>
          vi
            .mocked(client.testAuth)
            .mockResolvedValue({ ...RESPONSE_WITH_TOKEN, user_id: undefined }),
      },
    ];

    it.each(scenarios)('should print no xox string for $name', async ({ args, arrange }) => {
      arrange(mockSlackClient);

      await program.parseAsync(['node', 'slack-cli', ...args]);

      // 何も出ていなければ下の検査は何も確かめないので、先に出力があることと、
      // トークンが処理の中に実際にあったことを確かめる
      expect(printedText()).not.toBe('');
      expect(SlackApiClient).toHaveBeenCalledWith(TOKEN);
      expect(printedText()).not.toMatch(/xox/i);
    });
  });

  describe('failures exit with code 1', () => {
    it('should fail for a bot token (auth.test returns bot_id)', async () => {
      vi.mocked(mockSlackClient.testAuth).mockResolvedValue({
        ...USER_RESPONSE,
        bot_id: 'B1234567890',
      });

      await program.parseAsync(['node', 'slack-cli', 'whoami', '--format', 'json']);

      expect(mockConsole.errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Error:'),
        'The token is not a user token (auth.test returned a bot_id)'
      );
      expect(mockConsole.exitSpy).toHaveBeenCalledWith(1);
      expect(mockConsole.logSpy).not.toHaveBeenCalled();
    });

    it('should fail when auth.test fails', async () => {
      vi.mocked(mockSlackClient.testAuth).mockRejectedValue(
        new Error('An API error occurred: invalid_auth')
      );

      await program.parseAsync(['node', 'slack-cli', 'whoami', '--format', 'json']);

      expect(mockConsole.errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Error:'),
        'An API error occurred: invalid_auth'
      );
      expect(mockConsole.exitSpy).toHaveBeenCalledWith(1);
      expect(mockConsole.logSpy).not.toHaveBeenCalled();
    });

    it.each([
      { name: 'user_id', patch: { user_id: undefined } },
      { name: 'an empty user_id', patch: { user_id: '' } },
      { name: 'team_id', patch: { team_id: undefined } },
      { name: 'an empty team_id', patch: { team_id: '' } },
    ])('should fail when the response has no $name', async ({ patch }) => {
      vi.mocked(mockSlackClient.testAuth).mockResolvedValue({ ...USER_RESPONSE, ...patch });

      await program.parseAsync(['node', 'slack-cli', 'whoami', '--format', 'json']);

      expect(mockConsole.errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Error:'),
        'auth.test did not return user_id and team_id'
      );
      expect(mockConsole.exitSpy).toHaveBeenCalledWith(1);
      expect(mockConsole.logSpy).not.toHaveBeenCalled();
    });

    it('should fail without creating a client when the profile has no configuration', async () => {
      vi.mocked(mockConfigManager.getConfig).mockResolvedValue(null);
      vi.mocked(mockConfigManager.listProfiles).mockResolvedValue([]);

      await program.parseAsync(['node', 'slack-cli', 'whoami']);

      expect(mockConsole.errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Error:'),
        expect.stringContaining('No configuration found')
      );
      expect(mockConsole.exitSpy).toHaveBeenCalledWith(1);
      expect(mockConsole.logSpy).not.toHaveBeenCalled();
      expect(SlackApiClient).not.toHaveBeenCalled();
    });
  });

  describe('--profile', () => {
    it('should read the configuration of the given profile', async () => {
      vi.mocked(mockSlackClient.testAuth).mockResolvedValue(USER_RESPONSE);

      await program.parseAsync(['node', 'slack-cli', 'whoami', '--profile', 'work']);

      expect(mockConfigManager.getConfig).toHaveBeenCalledWith('work');
      expect(SlackApiClient).toHaveBeenCalledWith(TOKEN);
    });

    it('should leave the profile to the configuration when --profile is omitted', async () => {
      vi.mocked(mockSlackClient.testAuth).mockResolvedValue(USER_RESPONSE);

      await program.parseAsync(['node', 'slack-cli', 'whoami']);

      expect(mockConfigManager.getConfig).toHaveBeenCalledWith(undefined);
    });
  });

  describe('--format validation', () => {
    it('should reject a format other than text and json before reading the config', async () => {
      const whoamiCommand = setupWhoamiCommand();
      whoamiCommand.exitOverride();
      whoamiCommand.configureOutput({ writeErr: () => undefined });

      await expect(
        whoamiCommand.parseAsync(['--format', 'table'], { from: 'user' })
      ).rejects.toThrow("Error: Invalid format 'table'. Must be one of: text, json");

      expect(mockConfigManager.getConfig).not.toHaveBeenCalled();
      expect(mockSlackClient.testAuth).not.toHaveBeenCalled();
    });
  });
});
