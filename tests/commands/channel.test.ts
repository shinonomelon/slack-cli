import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupChannelCommand } from '../../src/commands/channel';
import type { ChannelLastRead } from '../../src/types/slack';
import { ProfileConfigManager } from '../../src/utils/profile-config';
import { SlackApiClient } from '../../src/utils/slack-api-client';
import { createTestProgram, restoreMocks, setupMockConsole } from '../test-utils';

vi.mock('../../src/utils/slack-api-client');
vi.mock('../../src/utils/profile-config');

describe('channel command', () => {
  let program: ReturnType<typeof createTestProgram>;
  let mockSlackClient: SlackApiClient;
  let mockConfigManager: ProfileConfigManager;
  let mockConsole: ReturnType<typeof setupMockConsole>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockConfigManager = new ProfileConfigManager();
    vi.mocked(ProfileConfigManager).mockImplementation(function () {
      return mockConfigManager;
    });

    mockSlackClient = new SlackApiClient('test-token');
    vi.mocked(SlackApiClient).mockImplementation(function () {
      return mockSlackClient;
    });

    mockConsole = setupMockConsole();
    program = createTestProgram();
    program.addCommand(setupChannelCommand());
  });

  afterEach(() => {
    restoreMocks();
  });

  describe('info subcommand', () => {
    it('should display channel info in table format', async () => {
      vi.mocked(mockConfigManager.getConfig).mockResolvedValue({
        token: 'test-token',
        updatedAt: new Date().toISOString(),
      });

      vi.mocked(mockSlackClient.getChannelDetail).mockResolvedValue({
        id: 'C1234567890',
        name: 'general',
        is_private: false,
        is_archived: false,
        created: 1579075200,
        num_members: 42,
        topic: { value: 'Current topic', creator: 'U111', last_set: 1700000000 },
        purpose: { value: 'Current purpose', creator: 'U222', last_set: 1700000001 },
      });

      await program.parseAsync(['node', 'slack-cli', 'channel', 'info', '-c', 'general']);

      expect(mockSlackClient.getChannelDetail).toHaveBeenCalledWith('general');
      expect(mockConsole.logSpy).toHaveBeenCalledWith(expect.stringContaining('general'));
      expect(mockConsole.logSpy).toHaveBeenCalledWith(expect.stringContaining('Current topic'));
      expect(mockConsole.logSpy).toHaveBeenCalledWith(expect.stringContaining('Current purpose'));
    });

    it('should display channel info in json format', async () => {
      vi.mocked(mockConfigManager.getConfig).mockResolvedValue({
        token: 'test-token',
        updatedAt: new Date().toISOString(),
      });

      vi.mocked(mockSlackClient.getChannelDetail).mockResolvedValue({
        id: 'C1234567890',
        name: 'general',
        is_private: false,
        created: 1579075200,
        num_members: 10,
        topic: { value: 'Topic here' },
        purpose: { value: 'Purpose here' },
      });

      await program.parseAsync([
        'node',
        'slack-cli',
        'channel',
        'info',
        '-c',
        'general',
        '--format',
        'json',
      ]);

      const logCall = mockConsole.logSpy.mock.calls.find((call: unknown[]) => {
        try {
          if (typeof call[0] !== 'string') {
            return false;
          }
          JSON.parse(call[0]);
          return true;
        } catch {
          return false;
        }
      });

      expect(logCall).toBeDefined();
      const output = JSON.parse(logCall![0]);
      expect(output.name).toBe('general');
      expect(output.topic).toBe('Topic here');
      expect(output.purpose).toBe('Purpose here');
    });

    it('should display channel info in simple format', async () => {
      vi.mocked(mockConfigManager.getConfig).mockResolvedValue({
        token: 'test-token',
        updatedAt: new Date().toISOString(),
      });

      vi.mocked(mockSlackClient.getChannelDetail).mockResolvedValue({
        id: 'C1234567890',
        name: 'general',
        is_private: false,
        created: 1579075200,
        num_members: 10,
        topic: { value: 'Topic here' },
        purpose: { value: 'Purpose here' },
      });

      await program.parseAsync([
        'node',
        'slack-cli',
        'channel',
        'info',
        '-c',
        'general',
        '--format',
        'simple',
      ]);

      expect(mockConsole.logSpy).toHaveBeenCalledWith(expect.stringContaining('general'));
      expect(mockConsole.logSpy).toHaveBeenCalledWith(expect.stringContaining('Topic here'));
    });

    it('should handle missing topic and purpose', async () => {
      vi.mocked(mockConfigManager.getConfig).mockResolvedValue({
        token: 'test-token',
        updatedAt: new Date().toISOString(),
      });

      vi.mocked(mockSlackClient.getChannelDetail).mockResolvedValue({
        id: 'C1234567890',
        name: 'empty-channel',
        is_private: false,
        created: 1579075200,
      });

      await program.parseAsync(['node', 'slack-cli', 'channel', 'info', '-c', 'empty-channel']);

      expect(mockConsole.logSpy).toHaveBeenCalledWith(expect.stringContaining('empty-channel'));
    });
  });

  describe('set-topic subcommand', () => {
    it('should set channel topic successfully', async () => {
      vi.mocked(mockConfigManager.getConfig).mockResolvedValue({
        token: 'test-token',
        updatedAt: new Date().toISOString(),
      });

      vi.mocked(mockSlackClient.setTopic).mockResolvedValue();

      await program.parseAsync([
        'node',
        'slack-cli',
        'channel',
        'set-topic',
        '-c',
        'general',
        '--topic',
        'New topic',
      ]);

      expect(mockSlackClient.setTopic).toHaveBeenCalledWith('general', 'New topic');
      expect(mockConsole.logSpy).toHaveBeenCalledWith(expect.stringContaining('general'));
    });

    it('should handle API errors gracefully', async () => {
      vi.mocked(mockConfigManager.getConfig).mockResolvedValue({
        token: 'test-token',
        updatedAt: new Date().toISOString(),
      });

      vi.mocked(mockSlackClient.setTopic).mockRejectedValue(new Error('not_in_channel'));

      await program.parseAsync([
        'node',
        'slack-cli',
        'channel',
        'set-topic',
        '-c',
        'general',
        '--topic',
        'New topic',
      ]);

      expect(mockConsole.errorSpy).toHaveBeenCalledWith('✗ Error:', 'not_in_channel');
      expect(mockConsole.exitSpy).toHaveBeenCalledWith(1);
    });

    it('should use specified profile', async () => {
      vi.mocked(mockConfigManager.getConfig).mockResolvedValue({
        token: 'work-token',
        updatedAt: new Date().toISOString(),
      });

      vi.mocked(mockSlackClient.setTopic).mockResolvedValue();

      await program.parseAsync([
        'node',
        'slack-cli',
        'channel',
        'set-topic',
        '-c',
        'general',
        '--topic',
        'Test',
        '--profile',
        'work',
      ]);

      expect(mockConfigManager.getConfig).toHaveBeenCalledWith('work');
    });
  });

  describe('set-purpose subcommand', () => {
    it('should set channel purpose successfully', async () => {
      vi.mocked(mockConfigManager.getConfig).mockResolvedValue({
        token: 'test-token',
        updatedAt: new Date().toISOString(),
      });

      vi.mocked(mockSlackClient.setPurpose).mockResolvedValue();

      await program.parseAsync([
        'node',
        'slack-cli',
        'channel',
        'set-purpose',
        '-c',
        'general',
        '--purpose',
        'New purpose',
      ]);

      expect(mockSlackClient.setPurpose).toHaveBeenCalledWith('general', 'New purpose');
      expect(mockConsole.logSpy).toHaveBeenCalledWith(expect.stringContaining('general'));
    });

    it('should handle API errors gracefully', async () => {
      vi.mocked(mockConfigManager.getConfig).mockResolvedValue({
        token: 'test-token',
        updatedAt: new Date().toISOString(),
      });

      vi.mocked(mockSlackClient.setPurpose).mockRejectedValue(new Error('channel_not_found'));

      await program.parseAsync([
        'node',
        'slack-cli',
        'channel',
        'set-purpose',
        '-c',
        'unknown',
        '--purpose',
        'New purpose',
      ]);

      expect(mockConsole.errorSpy).toHaveBeenCalledWith('✗ Error:', 'channel_not_found');
      expect(mockConsole.exitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe('last-read subcommand', () => {
    // beforeEach が token 'test-token' で作る分と区別するため、各テストは別の token を使う
    const clientCallsFor = (token: string) =>
      vi.mocked(SlackApiClient).mock.calls.filter((args) => args[0] === token);

    const useToken = (token: string) =>
      vi.mocked(mockConfigManager.getConfig).mockResolvedValue({
        token,
        updatedAt: new Date().toISOString(),
      });

    const lastReadRows: ChannelLastRead[] = [
      { channelId: 'C111', lastRead: '1759500000.123456', reason: null },
      { channelId: 'C222', lastRead: null, reason: 'no_last_read' },
      { channelId: 'C333', lastRead: null, reason: 'rate_limited', retryAfter: 45 },
      { channelId: 'C444', lastRead: null, reason: 'not_visible' },
      { channelId: 'C555', lastRead: null, reason: 'error' },
    ];

    it('should print channelId, lastRead and reason for each ID in the order given when --format json', async () => {
      useToken('last-read-token');
      vi.mocked(mockSlackClient.getLastReads).mockResolvedValue(lastReadRows);

      await program.parseAsync([
        'node',
        'slack-cli',
        'channel',
        'last-read',
        'C111',
        'C222',
        'C333',
        'C444',
        'C555',
        '--format',
        'json',
      ]);

      expect(mockSlackClient.getLastReads).toHaveBeenCalledWith([
        'C111',
        'C222',
        'C333',
        'C444',
        'C555',
      ]);
      // 標準出力は JSON だけ（警告は標準エラーに出る）
      expect(mockConsole.logSpy).toHaveBeenCalledTimes(1);
      const printed = mockConsole.logSpy.mock.calls[0][0] as string;
      const output = JSON.parse(printed);
      expect(output).toStrictEqual(lastReadRows);
      expect(printed).toBe(JSON.stringify(output, null, 2));
      // 取れた行も reason は null で出す（キーを落とさない）。retryAfter は rate_limited の行だけ
      expect(output.map((row: object) => Object.keys(row))).toEqual([
        ['channelId', 'lastRead', 'reason'],
        ['channelId', 'lastRead', 'reason'],
        ['channelId', 'lastRead', 'reason', 'retryAfter'],
        ['channelId', 'lastRead', 'reason'],
        ['channelId', 'lastRead', 'reason'],
      ]);
      // 会話ごとの失敗では、終了コードは0のまま
      expect(mockConsole.exitSpy).not.toHaveBeenCalled();
    });

    // 回数制限に当たったら retry-after を待たず、すぐ失敗させるクライアントで呼ぶ（形式に関わらず）
    it.each([
      ['table', ['--format', 'table']],
      ['simple', ['--format', 'simple']],
      ['json', ['--format', 'json']],
      ['the default format', []],
    ])('should create the client with rejectRateLimitedCalls for %s', async (_name, formatArgs) => {
      useToken('last-read-token');
      vi.mocked(mockSlackClient.getLastReads).mockResolvedValue(lastReadRows.slice(0, 1));

      await program.parseAsync([
        'node',
        'slack-cli',
        'channel',
        'last-read',
        'C111',
        ...formatArgs,
      ]);

      expect(clientCallsFor('last-read-token')).toEqual([
        ['last-read-token', { rejectRateLimitedCalls: true }],
      ]);
    });

    it('should print a table by default', async () => {
      useToken('last-read-token');
      vi.mocked(mockSlackClient.getLastReads).mockResolvedValue(lastReadRows);

      await program.parseAsync(['node', 'slack-cli', 'channel', 'last-read', 'C111', 'C222']);

      const printed = mockConsole.logSpy.mock.calls.map((call) => String(call[0]));
      expect(printed[0]).toContain('Channel');
      expect(printed[0]).toContain('Last Read');
      expect(printed[0]).toContain('Reason');
      const rows = printed.slice(2);
      expect(rows).toHaveLength(lastReadRows.length);
      expect(rows[0]).toContain('C111');
      expect(rows[0]).toContain('1759500000.123456');
      expect(rows[1]).toContain('C222');
      expect(rows[1]).toContain('no_last_read');
      expect(rows[2]).toContain('C333');
      expect(rows[2]).toContain('rate_limited');
      expect(rows[2]).toContain('45');
    });

    it('should print one line per conversation when --format simple', async () => {
      useToken('last-read-token');
      vi.mocked(mockSlackClient.getLastReads).mockResolvedValue(lastReadRows);

      await program.parseAsync([
        'node',
        'slack-cli',
        'channel',
        'last-read',
        'C111',
        '--format',
        'simple',
      ]);

      expect(mockConsole.logSpy.mock.calls.map((call) => call[0])).toEqual([
        'C111: 1759500000.123456',
        'C222: - (no_last_read)',
        'C333: - (rate_limited, retry after 45s)',
        'C444: - (not_visible)',
        'C555: - (error)',
      ]);
    });

    it('should use specified profile', async () => {
      useToken('work-token');
      vi.mocked(mockSlackClient.getLastReads).mockResolvedValue(lastReadRows.slice(0, 1));

      await program.parseAsync([
        'node',
        'slack-cli',
        'channel',
        'last-read',
        'C111',
        '--profile',
        'work',
      ]);

      expect(mockConfigManager.getConfig).toHaveBeenCalledWith('work');
    });

    it('should report a whole failure as an error, exit with 1 and print no result', async () => {
      useToken('last-read-token');
      vi.mocked(mockSlackClient.getLastReads).mockRejectedValue(
        Object.assign(new Error('An API error occurred: token_expired'), {
          code: 'slack_webapi_platform_error',
          data: { ok: false, error: 'token_expired' },
        })
      );

      await program.parseAsync([
        'node',
        'slack-cli',
        'channel',
        'last-read',
        'C111',
        '--format',
        'json',
      ]);

      expect(mockConsole.errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Error:'),
        'An API error occurred: token_expired'
      );
      expect(mockConsole.exitSpy).toHaveBeenCalledWith(1);
      expect(mockConsole.logSpy).not.toHaveBeenCalled();
    });

    it('should reject an unknown --format before calling Slack', async () => {
      const channelCommand = setupChannelCommand();
      channelCommand.exitOverride();
      const lastReadCommand = channelCommand.commands.find((c) => c.name() === 'last-read');
      lastReadCommand?.exitOverride();

      await expect(
        channelCommand.parseAsync(['last-read', 'C111', '--format', 'raw'], { from: 'user' })
      ).rejects.toThrow("Error: Invalid format 'raw'. Must be one of: table, simple, json");

      expect(mockSlackClient.getLastReads).not.toHaveBeenCalled();
    });

    it('should require at least one conversation ID', async () => {
      const channelCommand = setupChannelCommand();
      channelCommand.exitOverride();
      const lastReadCommand = channelCommand.commands.find((c) => c.name() === 'last-read');
      lastReadCommand?.exitOverride();

      await expect(channelCommand.parseAsync(['last-read'], { from: 'user' })).rejects.toThrow(
        "missing required argument 'ids'"
      );

      expect(mockSlackClient.getLastReads).not.toHaveBeenCalled();
    });
  });
});
