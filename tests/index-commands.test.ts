import { describe, expect, it } from 'vitest';
import { createProgram } from '../src/index';

describe('slack-cli program', () => {
  it('registers whoami with --format (default text) and --profile', () => {
    const program = createProgram();

    const whoami = program.commands.find((command) => command.name() === 'whoami');

    expect(whoami).toBeDefined();
    expect(whoami?.options.map((option) => option.long)).toEqual(['--format', '--profile']);
    expect(whoami?.options.find((option) => option.long === '--format')?.defaultValue).toBe('text');
  });

  // 呼び出し側（Slack Hub）は、whoami を持たない本家の slack-cli を「存在しないコマンドの失敗」
  // で見分ける。プログラムに独自の処理を足して、commander の既定の動きを変えてはいけない
  it('keeps commander default for an unknown command: exit code 1, nothing on stdout', async () => {
    const program = createProgram();
    const stdout: string[] = [];
    const stderr: string[] = [];
    program.exitOverride();
    program.configureOutput({
      writeOut: (text) => stdout.push(text),
      writeErr: (text) => stderr.push(text),
    });

    await expect(
      program.parseAsync(['node', 'slack-cli', 'no-such-command'])
    ).rejects.toMatchObject({
      code: 'commander.unknownCommand',
      exitCode: 1,
    });

    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["error: unknown command 'no-such-command'\n"]);
  });
});
