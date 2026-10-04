import chalk from 'chalk';
import * as fs from 'fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupSendCommand } from '../../src/commands/send';
import { ERROR_MESSAGES, SUCCESS_MESSAGES } from '../../src/utils/constants';
import { ProfileConfigManager } from '../../src/utils/profile-config';
import { SlackApiClient } from '../../src/utils/slack-api-client';
import { createTestProgram, restoreMocks, setupMockConsole } from '../test-utils';

vi.mock('../../src/utils/slack-api-client');
vi.mock('../../src/utils/profile-config');
vi.mock('fs/promises');

describe('send command', () => {
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
    program.addCommand(setupSendCommand());
  });

  afterEach(() => {
    restoreMocks();
  });

  describe('send message with -m option', () => {
    it('should send a message to specified channel', async () => {
      vi.mocked(mockConfigManager.getConfig).mockResolvedValue({
        token: 'test-token',
        updatedAt: new Date().toISOString(),
      });
      vi.mocked(mockSlackClient.sendMessage).mockResolvedValue({
        ok: true,
        ts: '1234567890.123456',
      });

      await program.parseAsync([
        'node',
        'slack-cli',
        'send',
        '-c',
        'general',
        '-m',
        'Hello, World!',
      ]);

      expect(mockSlackClient.sendMessage).toHaveBeenCalledWith(
        'general',
        'Hello, World!',
        undefined,
        undefined
      );
      expect(mockConsole.logSpy).toHaveBeenCalledWith(
        expect.stringContaining(SUCCESS_MESSAGES.MESSAGE_SENT('general'))
      );
    });

    it('should use specified profile', async () => {
      vi.mocked(mockConfigManager.getConfig).mockResolvedValue({
        token: 'work-token',
        updatedAt: new Date().toISOString(),
      });
      vi.mocked(mockSlackClient.sendMessage).mockResolvedValue({
        ok: true,
        ts: '1234567890.123456',
      });

      await program.parseAsync([
        'node',
        'slack-cli',
        'send',
        '-c',
        'general',
        '-m',
        'Hello',
        '--profile',
        'work',
      ]);

      expect(mockConfigManager.getConfig).toHaveBeenCalledWith('work');
      expect(SlackApiClient).toHaveBeenCalledWith('work-token');
    });
  });

  describe('send message with -f option', () => {
    it('should send message from file', async () => {
      const fileContent = 'Message from file\nLine 2';
      vi.mocked(fs.readFile).mockResolvedValue(fileContent);
      vi.mocked(mockConfigManager.getConfig).mockResolvedValue({
        token: 'test-token',
        updatedAt: new Date().toISOString(),
      });
      vi.mocked(mockSlackClient.sendMessage).mockResolvedValue({
        ok: true,
        ts: '1234567890.123456',
      });

      await program.parseAsync(['node', 'slack-cli', 'send', '-c', 'general', '-f', 'message.txt']);

      expect(fs.readFile).toHaveBeenCalledWith('message.txt', 'utf-8');
      expect(mockSlackClient.sendMessage).toHaveBeenCalledWith(
        'general',
        fileContent,
        undefined,
        undefined
      );
    });
  });

  describe('send Block Kit message', () => {
    it('should send blocks from --blocks with fallback text', async () => {
      const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: '*Hello*' } }];
      vi.mocked(mockConfigManager.getConfig).mockResolvedValue({
        token: 'test-token',
        updatedAt: new Date().toISOString(),
      });
      vi.mocked(mockSlackClient.sendMessage).mockResolvedValue({
        ok: true,
        ts: '1234567890.123456',
      });

      await program.parseAsync([
        'node',
        'slack-cli',
        'send',
        '-c',
        'general',
        '--blocks',
        JSON.stringify(blocks),
        '-m',
        'Hello',
      ]);

      expect(mockSlackClient.sendMessage).toHaveBeenCalledWith(
        'general',
        'Hello',
        undefined,
        blocks
      );
    });

    it('should send blocks from --blocks-file without fallback text', async () => {
      const blocks = [{ type: 'divider' }];
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(blocks));
      vi.mocked(mockConfigManager.getConfig).mockResolvedValue({
        token: 'test-token',
        updatedAt: new Date().toISOString(),
      });
      vi.mocked(mockSlackClient.sendMessage).mockResolvedValue({
        ok: true,
        ts: '1234567890.123456',
      });

      await program.parseAsync([
        'node',
        'slack-cli',
        'send',
        '-c',
        'general',
        '--blocks-file',
        'blocks.json',
      ]);

      expect(fs.readFile).toHaveBeenCalledWith('blocks.json', 'utf-8');
      expect(mockSlackClient.sendMessage).toHaveBeenCalledWith(
        'general',
        undefined,
        undefined,
        blocks
      );
    });

    it('should schedule blocks from --blocks-file', async () => {
      const blocks = [{ type: 'divider' }];
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(blocks));
      vi.mocked(mockConfigManager.getConfig).mockResolvedValue({
        token: 'test-token',
        updatedAt: new Date().toISOString(),
      });
      vi.mocked(mockSlackClient.scheduleMessage).mockResolvedValue({
        ok: true,
        scheduled_message_id: 'Q1298393284',
        post_at: 2051258400,
      });

      await program.parseAsync([
        'node',
        'slack-cli',
        'send',
        '-c',
        'general',
        '--blocks-file',
        'blocks.json',
        '--at',
        '2035-01-01T10:00:00Z',
      ]);

      expect(mockSlackClient.scheduleMessage).toHaveBeenCalledWith(
        'general',
        undefined,
        2051258400,
        undefined,
        blocks
      );
      expect(mockSlackClient.sendMessage).not.toHaveBeenCalled();
    });

    it('should fail when --blocks is not a JSON array', async () => {
      await program.parseAsync([
        'node',
        'slack-cli',
        'send',
        '-c',
        'general',
        '--blocks',
        '{"type":"divider"}',
      ]);

      expect(mockConsole.errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Error:'),
        'Block Kit blocks must be a JSON array'
      );
      expect(mockConsole.exitSpy).toHaveBeenCalledWith(1);
    });

    it('should fail when --blocks is invalid JSON', async () => {
      await program.parseAsync(['node', 'slack-cli', 'send', '-c', 'general', '--blocks', '{']);

      expect(mockConsole.errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Error:'),
        ERROR_MESSAGES.INVALID_BLOCKS_JSON
      );
      expect(mockConsole.exitSpy).toHaveBeenCalledWith(1);
    });

    it('should fail when a block does not have type', async () => {
      await program.parseAsync([
        'node',
        'slack-cli',
        'send',
        '-c',
        'general',
        '--blocks',
        '[{"text":"missing type"}]',
      ]);

      expect(mockConsole.errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Error:'),
        'Each Block Kit block must be an object with a string type'
      );
      expect(mockConsole.exitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe('send reply to thread', () => {
    it('should send a reply to a thread with --thread option', async () => {
      vi.mocked(mockConfigManager.getConfig).mockResolvedValue({
        token: 'test-token',
        updatedAt: new Date().toISOString(),
      });
      vi.mocked(mockSlackClient.sendMessage).mockResolvedValue({
        ok: true,
        ts: '1234567890.123456',
      });

      await program.parseAsync([
        'node',
        'slack-cli',
        'send',
        '-c',
        'general',
        '-m',
        'Reply to thread',
        '--thread',
        '1719207629.000100',
      ]);

      expect(mockSlackClient.sendMessage).toHaveBeenCalledWith(
        'general',
        'Reply to thread',
        '1719207629.000100',
        undefined
      );
      expect(mockConsole.logSpy).toHaveBeenCalledWith(
        expect.stringContaining(SUCCESS_MESSAGES.MESSAGE_SENT('general'))
      );
    });

    it('should send a reply to a thread with -t option', async () => {
      vi.mocked(mockConfigManager.getConfig).mockResolvedValue({
        token: 'test-token',
        updatedAt: new Date().toISOString(),
      });
      vi.mocked(mockSlackClient.sendMessage).mockResolvedValue({
        ok: true,
        ts: '1234567890.123456',
      });

      await program.parseAsync([
        'node',
        'slack-cli',
        'send',
        '-c',
        'general',
        '-m',
        'Reply to thread',
        '-t',
        '1719207629.000100',
      ]);

      expect(mockSlackClient.sendMessage).toHaveBeenCalledWith(
        'general',
        'Reply to thread',
        '1719207629.000100',
        undefined
      );
      expect(mockConsole.logSpy).toHaveBeenCalledWith(
        expect.stringContaining(SUCCESS_MESSAGES.MESSAGE_SENT('general'))
      );
    });

    it('should validate thread timestamp format', async () => {
      vi.mocked(mockConfigManager.getConfig).mockResolvedValue({
        token: 'test-token',
        updatedAt: new Date().toISOString(),
      });

      const sendCommand = setupSendCommand();
      sendCommand.exitOverride();

      await expect(
        sendCommand.parseAsync(['-c', 'general', '-m', 'Reply', '-t', 'invalid-timestamp'], {
          from: 'user',
        })
      ).rejects.toThrow(ERROR_MESSAGES.INVALID_THREAD_TIMESTAMP);
    });

    it('should send a reply to a thread with file content', async () => {
      const fileContent = 'Reply from file\nLine 2';
      vi.mocked(fs.readFile).mockResolvedValue(fileContent);
      vi.mocked(mockConfigManager.getConfig).mockResolvedValue({
        token: 'test-token',
        updatedAt: new Date().toISOString(),
      });
      vi.mocked(mockSlackClient.sendMessage).mockResolvedValue({
        ok: true,
        ts: '1234567890.123456',
      });

      await program.parseAsync([
        'node',
        'slack-cli',
        'send',
        '-c',
        'general',
        '-f',
        'reply.txt',
        '-t',
        '1719207629.000100',
      ]);

      expect(fs.readFile).toHaveBeenCalledWith('reply.txt', 'utf-8');
      expect(mockSlackClient.sendMessage).toHaveBeenCalledWith(
        'general',
        fileContent,
        '1719207629.000100',
        undefined
      );
      expect(mockConsole.logSpy).toHaveBeenCalledWith(
        expect.stringContaining(SUCCESS_MESSAGES.MESSAGE_SENT('general'))
      );
    });
  });

  describe('schedule message', () => {
    it('should schedule message with --at', async () => {
      vi.mocked(mockConfigManager.getConfig).mockResolvedValue({
        token: 'test-token',
        updatedAt: new Date().toISOString(),
      });
      vi.mocked(mockSlackClient.scheduleMessage).mockResolvedValue({
        ok: true,
        scheduled_message_id: 'Q1298393284',
        post_at: 2051258400,
      });

      await program.parseAsync([
        'node',
        'slack-cli',
        'send',
        '-c',
        'general',
        '-m',
        'Future message',
        '--at',
        '2035-01-01T10:00:00Z',
      ]);

      expect(mockSlackClient.scheduleMessage).toHaveBeenCalledWith(
        'general',
        'Future message',
        2051258400,
        undefined,
        undefined
      );
      expect(mockSlackClient.sendMessage).not.toHaveBeenCalled();
      expect(mockConsole.logSpy).toHaveBeenCalledWith(
        expect.stringContaining('Message scheduled to #general')
      );
    });

    it('should schedule message with --after', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-12T00:00:00Z'));

      vi.mocked(mockConfigManager.getConfig).mockResolvedValue({
        token: 'test-token',
        updatedAt: new Date().toISOString(),
      });
      vi.mocked(mockSlackClient.scheduleMessage).mockResolvedValue({
        ok: true,
        scheduled_message_id: 'Q1298393284',
        post_at: 1770868800,
      });

      await program.parseAsync([
        'node',
        'slack-cli',
        'send',
        '-c',
        'general',
        '-m',
        'Future message',
        '--after',
        '10',
      ]);

      expect(mockSlackClient.scheduleMessage).toHaveBeenCalledWith(
        'general',
        'Future message',
        1770855000,
        undefined,
        undefined
      );

      vi.useRealTimers();
    });
  });

  describe('validation', () => {
    it('should fail when no message or file is provided', async () => {
      const sendCommand = setupSendCommand();
      sendCommand.exitOverride();

      await expect(sendCommand.parseAsync(['-c', 'general'], { from: 'user' })).rejects.toThrow(
        `Error: ${ERROR_MESSAGES.NO_MESSAGE_FILE_OR_BLOCKS}`
      );
    });

    it('should fail when both message and file are provided', async () => {
      const sendCommand = setupSendCommand();
      sendCommand.exitOverride();

      await expect(
        sendCommand.parseAsync(['-c', 'general', '-m', 'Hello', '-f', 'file.txt'], {
          from: 'user',
        })
      ).rejects.toThrow(`Error: ${ERROR_MESSAGES.BOTH_MESSAGE_AND_FILE}`);
    });

    it('should fail when both --blocks and --blocks-file are provided', async () => {
      const sendCommand = setupSendCommand();
      sendCommand.exitOverride();

      await expect(
        sendCommand.parseAsync(
          ['-c', 'general', '--blocks', '[{"type":"divider"}]', '--blocks-file', 'blocks.json'],
          {
            from: 'user',
          }
        )
      ).rejects.toThrow(`Error: ${ERROR_MESSAGES.BOTH_BLOCKS_AND_BLOCKS_FILE}`);
    });

    it('should fail when both --at and --after are provided', async () => {
      const sendCommand = setupSendCommand();
      sendCommand.exitOverride();

      await expect(
        sendCommand.parseAsync(
          ['-c', 'general', '-m', 'Hello', '--at', '2030-01-01T10:00:00Z', '--after', '10'],
          {
            from: 'user',
          }
        )
      ).rejects.toThrow(`Error: ${ERROR_MESSAGES.BOTH_SCHEDULE_OPTIONS}`);
    });

    it('should fail with invalid --at', async () => {
      const sendCommand = setupSendCommand();
      sendCommand.exitOverride();

      await expect(
        sendCommand.parseAsync(['-c', 'general', '-m', 'Hello', '--at', 'invalid-date'], {
          from: 'user',
        })
      ).rejects.toThrow(`Error: ${ERROR_MESSAGES.INVALID_SCHEDULE_AT}`);
    });

    it('should fail with past --at', async () => {
      const sendCommand = setupSendCommand();
      sendCommand.exitOverride();

      await expect(
        sendCommand.parseAsync(['-c', 'general', '-m', 'Hello', '--at', '1'], {
          from: 'user',
        })
      ).rejects.toThrow(`Error: ${ERROR_MESSAGES.SCHEDULE_TIME_IN_PAST}`);
    });

    it('should fail with invalid --after', async () => {
      const sendCommand = setupSendCommand();
      sendCommand.exitOverride();

      await expect(
        sendCommand.parseAsync(['-c', 'general', '-m', 'Hello', '--after', '0'], {
          from: 'user',
        })
      ).rejects.toThrow(`Error: ${ERROR_MESSAGES.INVALID_SCHEDULE_AFTER}`);
    });

    it('should fail when no target is provided', async () => {
      const sendCommand = setupSendCommand();
      sendCommand.exitOverride();

      await expect(sendCommand.parseAsync(['-m', 'Hello'], { from: 'user' })).rejects.toThrow(
        'You must specify one of: --channel, --user, or --email'
      );
    });

    it('should fail when both --channel and --user are provided', async () => {
      const sendCommand = setupSendCommand();
      sendCommand.exitOverride();

      await expect(
        sendCommand.parseAsync(['-c', 'general', '--user', 'john', '-m', 'Hello'], {
          from: 'user',
        })
      ).rejects.toThrow('Cannot use --channel with --user or --email');
    });

    it('should fail when both --channel and --email are provided', async () => {
      const sendCommand = setupSendCommand();
      sendCommand.exitOverride();

      await expect(
        sendCommand.parseAsync(['-c', 'general', '--email', 'john@example.com', '-m', 'Hello'], {
          from: 'user',
        })
      ).rejects.toThrow('Cannot use --channel with --user or --email');
    });

    it('should fail when both --user and --email are provided', async () => {
      const sendCommand = setupSendCommand();
      sendCommand.exitOverride();

      await expect(
        sendCommand.parseAsync(['--user', 'john', '--email', 'john@example.com', '-m', 'Hello'], {
          from: 'user',
        })
      ).rejects.toThrow('Cannot use --user and --email together');
    });
  });

  describe('DM via --user', () => {
    it('should send DM by resolving username to DM channel', async () => {
      vi.mocked(mockConfigManager.getConfig).mockResolvedValue({
        token: 'test-token',
        updatedAt: new Date().toISOString(),
      });
      vi.mocked(mockSlackClient.resolveUserIdByName).mockResolvedValue('U1234567890');
      vi.mocked(mockSlackClient.openDmChannel).mockResolvedValue('D9876543210');
      vi.mocked(mockSlackClient.sendMessage).mockResolvedValue({
        ok: true,
        ts: '1234567890.123456',
      });

      await program.parseAsync([
        'node',
        'slack-cli',
        'send',
        '--user',
        'john',
        '-m',
        'Hello via DM!',
      ]);

      expect(mockSlackClient.resolveUserIdByName).toHaveBeenCalledWith('john');
      expect(mockSlackClient.openDmChannel).toHaveBeenCalledWith('U1234567890');
      expect(mockSlackClient.sendMessage).toHaveBeenCalledWith(
        'D9876543210',
        'Hello via DM!',
        undefined,
        undefined
      );
      expect(mockConsole.logSpy).toHaveBeenCalledWith(expect.stringContaining('DM sent to @john'));
    });

    it('should handle user not found error', async () => {
      vi.mocked(mockConfigManager.getConfig).mockResolvedValue({
        token: 'test-token',
        updatedAt: new Date().toISOString(),
      });
      vi.mocked(mockSlackClient.resolveUserIdByName).mockRejectedValue(
        new Error("User 'unknown' not found")
      );

      await program.parseAsync(['node', 'slack-cli', 'send', '--user', 'unknown', '-m', 'Hello']);

      expect(mockConsole.errorSpy).toHaveBeenCalledWith('✗ Error:', "User 'unknown' not found");
      expect(mockConsole.exitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe('DM via --email', () => {
    it('should send DM by resolving email to DM channel', async () => {
      vi.mocked(mockConfigManager.getConfig).mockResolvedValue({
        token: 'test-token',
        updatedAt: new Date().toISOString(),
      });
      vi.mocked(mockSlackClient.lookupUserByEmail).mockResolvedValue({
        id: 'U1234567890',
        name: 'john',
      });
      vi.mocked(mockSlackClient.openDmChannel).mockResolvedValue('D9876543210');
      vi.mocked(mockSlackClient.sendMessage).mockResolvedValue({
        ok: true,
        ts: '1234567890.123456',
      });

      await program.parseAsync([
        'node',
        'slack-cli',
        'send',
        '--email',
        'john@example.com',
        '-m',
        'Hello via email DM!',
      ]);

      expect(mockSlackClient.lookupUserByEmail).toHaveBeenCalledWith('john@example.com');
      expect(mockSlackClient.openDmChannel).toHaveBeenCalledWith('U1234567890');
      expect(mockSlackClient.sendMessage).toHaveBeenCalledWith(
        'D9876543210',
        'Hello via email DM!',
        undefined,
        undefined
      );
      expect(mockConsole.logSpy).toHaveBeenCalledWith(
        expect.stringContaining('DM sent to john@example.com')
      );
    });

    it('should handle email not found error', async () => {
      vi.mocked(mockConfigManager.getConfig).mockResolvedValue({
        token: 'test-token',
        updatedAt: new Date().toISOString(),
      });
      vi.mocked(mockSlackClient.lookupUserByEmail).mockRejectedValue(new Error('users_not_found'));

      await program.parseAsync([
        'node',
        'slack-cli',
        'send',
        '--email',
        'unknown@example.com',
        '-m',
        'Hello',
      ]);

      expect(mockConsole.errorSpy).toHaveBeenCalledWith('✗ Error:', 'users_not_found');
      expect(mockConsole.exitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe('DM via --user-id', () => {
    beforeEach(() => {
      vi.mocked(mockConfigManager.getConfig).mockResolvedValue({
        token: 'test-token',
        updatedAt: new Date().toISOString(),
      });
    });

    it('should open the DM with the user ID and send to the opened conversation', async () => {
      vi.mocked(mockSlackClient.openDmChannel).mockResolvedValue('D9876543210');
      vi.mocked(mockSlackClient.sendMessage).mockResolvedValue({
        ok: true,
        ts: '1234567890.123456',
      });

      await program.parseAsync([
        'node',
        'slack-cli',
        'send',
        '--user-id',
        'U1234567890',
        '-m',
        'Hello via user ID!',
      ]);

      expect(mockSlackClient.openDmChannel).toHaveBeenCalledWith('U1234567890');
      expect(mockSlackClient.sendMessage).toHaveBeenCalledWith(
        'D9876543210',
        'Hello via user ID!',
        undefined,
        undefined
      );
      // No name or email lookup: skipping the users.list scan is the point of --user-id.
      expect(mockSlackClient.resolveUserIdByName).not.toHaveBeenCalled();
      expect(mockSlackClient.lookupUserByEmail).not.toHaveBeenCalled();
      expect(mockConsole.logSpy).toHaveBeenCalledTimes(1);
      expect(mockConsole.logSpy).toHaveBeenCalledWith(chalk.green('✓ DM sent to U1234567890'));
    });

    it('should report the opened conversation in the JSON output', async () => {
      vi.mocked(mockSlackClient.openDmChannel).mockResolvedValue('D9876543210');
      // No channel in the response, so channelId can only come from the opened DM.
      vi.mocked(mockSlackClient.sendMessage).mockResolvedValue({
        ok: true,
        ts: '1234567890.123456',
      });

      await program.parseAsync([
        'node',
        'slack-cli',
        'send',
        '--user-id',
        'U1234567890',
        '-m',
        'Hello',
        '--format',
        'json',
      ]);

      expect(mockSlackClient.openDmChannel).toHaveBeenCalledWith('U1234567890');
      expect(mockSlackClient.sendMessage).toHaveBeenCalledWith(
        'D9876543210',
        'Hello',
        undefined,
        undefined
      );
      expect(mockConsole.logSpy).toHaveBeenCalledTimes(1);
      expect(mockConsole.logSpy).toHaveBeenCalledWith(
        JSON.stringify(
          { ok: true, channelId: 'D9876543210', ts: '1234567890.123456', threadTs: null },
          null,
          2
        )
      );
    });

    it('should accept the blocks, file and JSON options together', async () => {
      const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: '*Hello*' } }];
      vi.mocked(fs.readFile).mockImplementation(async (path) =>
        path === 'blocks.json' ? JSON.stringify(blocks) : 'fallback text'
      );
      vi.mocked(mockSlackClient.openDmChannel).mockResolvedValue('D9876543210');
      vi.mocked(mockSlackClient.sendMessage).mockResolvedValue({
        ok: true,
        channel: 'D9876543210',
        ts: '1234567890.123456',
      });

      await program.parseAsync([
        'node',
        'slack-cli',
        'send',
        '--user-id',
        'U1234567890',
        '--blocks-file',
        'blocks.json',
        '-f',
        'fallback.txt',
        '--format',
        'json',
      ]);

      expect(mockSlackClient.sendMessage).toHaveBeenCalledWith(
        'D9876543210',
        'fallback text',
        undefined,
        blocks
      );
      expect(mockConsole.logSpy).toHaveBeenCalledTimes(1);
      expect(mockConsole.logSpy).toHaveBeenCalledWith(
        JSON.stringify(
          { ok: true, channelId: 'D9876543210', ts: '1234567890.123456', threadTs: null },
          null,
          2
        )
      );
    });

    it('should schedule to the opened conversation', async () => {
      vi.mocked(mockSlackClient.openDmChannel).mockResolvedValue('D9876543210');
      vi.mocked(mockSlackClient.scheduleMessage).mockResolvedValue({
        ok: true,
        channel: 'D9876543210',
        scheduled_message_id: 'Q1298393284',
        post_at: 2051258400,
      });

      await program.parseAsync([
        'node',
        'slack-cli',
        'send',
        '--user-id',
        'U1234567890',
        '-m',
        'Later',
        '--at',
        '2035-01-01T10:00:00Z',
      ]);

      expect(mockSlackClient.scheduleMessage).toHaveBeenCalledWith(
        'D9876543210',
        'Later',
        2051258400,
        undefined,
        undefined
      );
      expect(mockConsole.logSpy).toHaveBeenCalledTimes(1);
      expect(mockConsole.logSpy).toHaveBeenCalledWith(
        chalk.green('✓ Message scheduled to U1234567890 at 2035-01-01T10:00:00.000Z')
      );
    });

    it('should not send when the DM cannot be opened', async () => {
      vi.mocked(mockSlackClient.openDmChannel).mockRejectedValue(new Error('user_not_found'));

      await program.parseAsync([
        'node',
        'slack-cli',
        'send',
        '--user-id',
        'U00000000',
        '-m',
        'Hello',
      ]);

      expect(mockConsole.errorSpy).toHaveBeenCalledWith('✗ Error:', 'user_not_found');
      expect(mockConsole.exitSpy).toHaveBeenCalledWith(1);
      expect(mockSlackClient.sendMessage).not.toHaveBeenCalled();
    });

    it.each([
      ['--channel', ['-c', 'general']],
      ['--user', ['--user', 'john']],
      ['--email', ['--email', 'john@example.com']],
    ])('should reject --user-id together with %s without sending', async (_flag, otherTarget) => {
      const sendCommand = setupSendCommand();
      sendCommand.exitOverride();

      await expect(
        sendCommand.parseAsync([...otherTarget, '--user-id', 'U1234567890', '-m', 'Hello'], {
          from: 'user',
        })
      ).rejects.toThrow('Error: Cannot use --user-id with --channel, --user, or --email');

      expect(mockSlackClient.openDmChannel).not.toHaveBeenCalled();
      expect(mockSlackClient.sendMessage).not.toHaveBeenCalled();
    });

    it('should keep the message for a missing target unchanged', async () => {
      const sendCommand = setupSendCommand();
      sendCommand.exitOverride();

      await expect(sendCommand.parseAsync(['-m', 'Hello'], { from: 'user' })).rejects.toThrow(
        /^Error: You must specify one of: --channel, --user, or --email$/
      );
    });

    it.each(['U1234567890', 'W1234567890'])('should accept %s as --user-id', async (userId) => {
      // 直前のテストが openDmChannel を reject のまま残すので、ここで明示的に stub する
      vi.mocked(mockSlackClient.openDmChannel).mockResolvedValue('D9876543210');
      vi.mocked(mockSlackClient.sendMessage).mockResolvedValue({
        ok: true,
        ts: '1234567890.123456',
      });

      await program.parseAsync(['node', 'slack-cli', 'send', '--user-id', userId, '-m', 'Hello']);

      expect(mockSlackClient.openDmChannel).toHaveBeenCalledWith(userId);
      expect(mockSlackClient.sendMessage).toHaveBeenCalledWith(
        'D9876543210',
        'Hello',
        undefined,
        undefined
      );
    });

    it.each([
      ['an empty string', ''],
      ['comma-separated IDs', 'U1234567890,U0987654321'],
      ['a lowercase ID', 'u1234567890'],
      ['a channel ID', 'C1234567890'],
      ['a user name', '@john'],
      ['an ID with a trailing space', 'U1234567890 '],
      ['only the prefix letter', 'U'],
    ])('should reject %s as --user-id without sending', async (_label, userId) => {
      const sendCommand = setupSendCommand();
      sendCommand.exitOverride();

      await expect(
        sendCommand.parseAsync(['--user-id', userId, '-m', 'Hello'], { from: 'user' })
      ).rejects.toThrow(
        `Error: Invalid --user-id '${userId}'. Must be a single Slack user ID such as U1234567890`
      );

      expect(mockSlackClient.openDmChannel).not.toHaveBeenCalled();
      expect(mockSlackClient.sendMessage).not.toHaveBeenCalled();
    });

    it('should reject --user-id= with no value', async () => {
      const sendCommand = setupSendCommand();
      sendCommand.exitOverride();

      await expect(
        sendCommand.parseAsync(['--user-id=', '-m', 'Hello'], { from: 'user' })
      ).rejects.toThrow("Error: Invalid --user-id ''. Must be a single Slack user ID");

      expect(mockSlackClient.sendMessage).not.toHaveBeenCalled();
    });

    // -c と一緒でも、不正な --user-id を黙って無視して -c に送ることはしない
    // （空文字は sendTarget に「指定なし」と数えられていた）。
    // カンマ区切りの行は、sendUserId が sendTarget より前に走る順序も固定する
    it.each([
      ['an empty --user-id', ''],
      ['comma-separated --user-id values', 'U1234567890,U0987654321'],
    ])('should reject %s given with --channel instead of ignoring it', async (_label, userId) => {
      const sendCommand = setupSendCommand();
      sendCommand.exitOverride();

      await expect(
        sendCommand.parseAsync(['-c', 'general', '--user-id', userId, '-m', 'Hello'], {
          from: 'user',
        })
      ).rejects.toThrow(`Error: Invalid --user-id '${userId}'. Must be a single Slack user ID`);

      expect(mockSlackClient.openDmChannel).not.toHaveBeenCalled();
      expect(mockSlackClient.sendMessage).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should handle missing configuration', async () => {
      vi.mocked(mockConfigManager.getConfig).mockResolvedValue(null);

      await program.parseAsync(['node', 'slack-cli', 'send', '-c', 'general', '-m', 'Hello']);

      expect(mockConsole.errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Error:'),
        expect.any(String)
      );
      expect(mockConsole.exitSpy).toHaveBeenCalledWith(1);
    });

    it('should handle Slack API errors', async () => {
      vi.mocked(mockConfigManager.getConfig).mockResolvedValue({
        token: 'test-token',
        updatedAt: new Date().toISOString(),
      });
      vi.mocked(mockSlackClient.sendMessage).mockRejectedValue(new Error('channel_not_found'));

      await program.parseAsync(['node', 'slack-cli', 'send', '-c', 'nonexistent', '-m', 'Hello']);

      expect(mockConsole.errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Error:'),
        expect.any(String)
      );
      expect(mockConsole.exitSpy).toHaveBeenCalledWith(1);
    });

    it('should handle file read errors', async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT: no such file'));
      vi.mocked(mockConfigManager.getConfig).mockResolvedValue({
        token: 'test-token',
        updatedAt: new Date().toISOString(),
      });

      await program.parseAsync([
        'node',
        'slack-cli',
        'send',
        '-c',
        'general',
        '-f',
        'nonexistent.txt',
      ]);

      expect(mockConsole.errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Error:'),
        expect.any(String)
      );
      expect(mockConsole.exitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe('--format text', () => {
    beforeEach(() => {
      vi.mocked(mockConfigManager.getConfig).mockResolvedValue({
        token: 'test-token',
        updatedAt: new Date().toISOString(),
      });
    });

    it('should print the same line as before when --format is omitted', async () => {
      vi.mocked(mockSlackClient.sendMessage).mockResolvedValue({
        ok: true,
        channel: 'C0123456789',
        ts: '1234567890.123456',
      });

      await program.parseAsync(['node', 'slack-cli', 'send', '-c', 'general', '-m', 'Hello']);

      expect(mockConsole.logSpy).toHaveBeenCalledTimes(1);
      expect(mockConsole.logSpy).toHaveBeenCalledWith(
        chalk.green(`✓ ${SUCCESS_MESSAGES.MESSAGE_SENT('general')}`)
      );
    });

    it('should print the same line with an explicit --format text', async () => {
      vi.mocked(mockSlackClient.sendMessage).mockResolvedValue({
        ok: true,
        channel: 'C0123456789',
        ts: '1234567890.123456',
      });

      await program.parseAsync([
        'node',
        'slack-cli',
        'send',
        '-c',
        'general',
        '-m',
        'Hello',
        '--format',
        'text',
      ]);

      expect(mockConsole.logSpy).toHaveBeenCalledTimes(1);
      expect(mockConsole.logSpy).toHaveBeenCalledWith(
        chalk.green(`✓ ${SUCCESS_MESSAGES.MESSAGE_SENT('general')}`)
      );
    });

    it('should keep the DM line unchanged', async () => {
      vi.mocked(mockSlackClient.resolveUserIdByName).mockResolvedValue('U1234567890');
      vi.mocked(mockSlackClient.openDmChannel).mockResolvedValue('D9876543210');
      vi.mocked(mockSlackClient.sendMessage).mockResolvedValue({
        ok: true,
        channel: 'D9876543210',
        ts: '1234567890.123456',
      });

      await program.parseAsync(['node', 'slack-cli', 'send', '--user', 'john', '-m', 'Hello']);

      expect(mockConsole.logSpy).toHaveBeenCalledTimes(1);
      expect(mockConsole.logSpy).toHaveBeenCalledWith(chalk.green('✓ DM sent to @john'));
    });

    it('should keep the scheduled line unchanged', async () => {
      vi.mocked(mockSlackClient.scheduleMessage).mockResolvedValue({
        ok: true,
        channel: 'C0123456789',
        scheduled_message_id: 'Q1298393284',
        post_at: 2051258400,
      });

      await program.parseAsync([
        'node',
        'slack-cli',
        'send',
        '-c',
        'general',
        '-m',
        'Later',
        '--at',
        '2035-01-01T10:00:00Z',
      ]);

      expect(mockConsole.logSpy).toHaveBeenCalledTimes(1);
      expect(mockConsole.logSpy).toHaveBeenCalledWith(
        chalk.green(
          `✓ ${SUCCESS_MESSAGES.MESSAGE_SCHEDULED('general', '2035-01-01T10:00:00.000Z')}`
        )
      );
    });
  });

  describe('--format json', () => {
    beforeEach(() => {
      vi.mocked(mockConfigManager.getConfig).mockResolvedValue({
        token: 'test-token',
        updatedAt: new Date().toISOString(),
      });
    });

    it('should print the channel ID and ts of the posted message', async () => {
      vi.mocked(mockSlackClient.sendMessage).mockResolvedValue({
        ok: true,
        channel: 'C0123456789',
        ts: '1234567890.123456',
      });

      await program.parseAsync([
        'node',
        'slack-cli',
        'send',
        '-c',
        'general',
        '-m',
        'Hello',
        '--format',
        'json',
      ]);

      // One call with the exact text pins key order, indentation and the absence of the ✓ line.
      expect(mockConsole.logSpy).toHaveBeenCalledTimes(1);
      expect(mockConsole.logSpy).toHaveBeenCalledWith(
        JSON.stringify(
          { ok: true, channelId: 'C0123456789', ts: '1234567890.123456', threadTs: null },
          null,
          2
        )
      );
    });

    it('should fall back to the target when the response has no channel', async () => {
      vi.mocked(mockSlackClient.sendMessage).mockResolvedValue({
        ok: true,
        ts: '1234567890.123456',
      });

      await program.parseAsync([
        'node',
        'slack-cli',
        'send',
        '-c',
        'C0123456789',
        '-m',
        'Hello',
        '--format',
        'json',
      ]);

      expect(mockConsole.logSpy).toHaveBeenCalledTimes(1);
      expect(mockConsole.logSpy).toHaveBeenCalledWith(
        JSON.stringify(
          { ok: true, channelId: 'C0123456789', ts: '1234567890.123456', threadTs: null },
          null,
          2
        )
      );
    });

    it('should report the parent ts as threadTs when replying to a thread', async () => {
      vi.mocked(mockSlackClient.sendMessage).mockResolvedValue({
        ok: true,
        channel: 'C0123456789',
        ts: '1719207700.000200',
      });

      await program.parseAsync([
        'node',
        'slack-cli',
        'send',
        '-c',
        'general',
        '-m',
        'Reply',
        '-t',
        '1719207629.000100',
        '--format',
        'json',
      ]);

      expect(mockConsole.logSpy).toHaveBeenCalledTimes(1);
      expect(mockConsole.logSpy).toHaveBeenCalledWith(
        JSON.stringify(
          {
            ok: true,
            channelId: 'C0123456789',
            ts: '1719207700.000200',
            threadTs: '1719207629.000100',
          },
          null,
          2
        )
      );
    });

    it('should print only JSON for a DM sent with --user', async () => {
      vi.mocked(mockSlackClient.resolveUserIdByName).mockResolvedValue('U1234567890');
      vi.mocked(mockSlackClient.openDmChannel).mockResolvedValue('D9876543210');
      vi.mocked(mockSlackClient.sendMessage).mockResolvedValue({
        ok: true,
        ts: '1234567890.123456',
      });

      await program.parseAsync([
        'node',
        'slack-cli',
        'send',
        '--user',
        'john',
        '-m',
        'Hello',
        '--format',
        'json',
      ]);

      expect(mockConsole.logSpy).toHaveBeenCalledTimes(1);
      expect(mockConsole.logSpy).toHaveBeenCalledWith(
        JSON.stringify(
          { ok: true, channelId: 'D9876543210', ts: '1234567890.123456', threadTs: null },
          null,
          2
        )
      );
    });

    it('should print the scheduled message as JSON', async () => {
      vi.mocked(mockSlackClient.scheduleMessage).mockResolvedValue({
        ok: true,
        channel: 'C0123456789',
        scheduled_message_id: 'Q1298393284',
        post_at: 2051258400,
      });

      await program.parseAsync([
        'node',
        'slack-cli',
        'send',
        '-c',
        'general',
        '-m',
        'Later',
        '--at',
        '2035-01-01T10:00:00Z',
        '--format',
        'json',
      ]);

      expect(mockSlackClient.sendMessage).not.toHaveBeenCalled();
      expect(mockConsole.logSpy).toHaveBeenCalledTimes(1);
      expect(mockConsole.logSpy).toHaveBeenCalledWith(
        JSON.stringify(
          {
            ok: true,
            scheduled: true,
            channelId: 'C0123456789',
            scheduledMessageId: 'Q1298393284',
            postAt: 2051258400,
          },
          null,
          2
        )
      );
    });

    it('should fall back to the requested time and target when the schedule response is sparse', async () => {
      vi.mocked(mockSlackClient.scheduleMessage).mockResolvedValue({
        ok: true,
        scheduled_message_id: 'Q1298393284',
      });

      await program.parseAsync([
        'node',
        'slack-cli',
        'send',
        '-c',
        'C0123456789',
        '-m',
        'Later',
        '--at',
        '2035-01-01T10:00:00Z',
        '--format',
        'json',
      ]);

      expect(mockConsole.logSpy).toHaveBeenCalledTimes(1);
      expect(mockConsole.logSpy).toHaveBeenCalledWith(
        JSON.stringify(
          {
            ok: true,
            scheduled: true,
            channelId: 'C0123456789',
            scheduledMessageId: 'Q1298393284',
            postAt: 2051258400,
          },
          null,
          2
        )
      );
    });

    it('should print null for ts when the response has none', async () => {
      vi.mocked(mockSlackClient.sendMessage).mockResolvedValue({ ok: true });

      await program.parseAsync([
        'node',
        'slack-cli',
        'send',
        '-c',
        'general',
        '-m',
        'Hello',
        '--format',
        'json',
      ]);

      expect(mockConsole.logSpy).toHaveBeenCalledTimes(1);
      expect(mockConsole.logSpy).toHaveBeenCalledWith(
        JSON.stringify({ ok: true, channelId: 'general', ts: null, threadTs: null }, null, 2)
      );
    });

    it('should never fail after the message was sent, even if the client resolves with nothing', async () => {
      // A failure after the API call would exit 1 and make the caller retry a message that was
      // already delivered. Stub explicitly: mockResolvedValue calls leak between tests here.
      vi.mocked(mockSlackClient.sendMessage).mockResolvedValue(undefined as never);

      await program.parseAsync([
        'node',
        'slack-cli',
        'send',
        '-c',
        'general',
        '-m',
        'Hello',
        '--format',
        'json',
      ]);

      expect(mockConsole.exitSpy).not.toHaveBeenCalled();
      expect(mockConsole.logSpy).toHaveBeenCalledTimes(1);
      expect(mockConsole.logSpy).toHaveBeenCalledWith(
        JSON.stringify({ ok: true, channelId: 'general', ts: null, threadTs: null }, null, 2)
      );
    });

    it('should keep reporting failures on stderr as before', async () => {
      vi.mocked(mockSlackClient.sendMessage).mockRejectedValue(new Error('channel_not_found'));

      await program.parseAsync([
        'node',
        'slack-cli',
        'send',
        '-c',
        'nonexistent',
        '-m',
        'Hello',
        '--format',
        'json',
      ]);

      expect(mockConsole.errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Error:'),
        'channel_not_found'
      );
      expect(mockConsole.exitSpy).toHaveBeenCalledWith(1);
      expect(mockConsole.logSpy).not.toHaveBeenCalled();
    });

    it('should reject formats other than text and json before sending', async () => {
      const sendCommand = setupSendCommand();
      sendCommand.exitOverride();

      await expect(
        sendCommand.parseAsync(['-c', 'general', '-m', 'Hello', '--format', 'table'], {
          from: 'user',
        })
      ).rejects.toThrow("Error: Invalid format 'table'. Must be one of: text, json");
      expect(mockSlackClient.sendMessage).not.toHaveBeenCalled();
    });
  });
});
