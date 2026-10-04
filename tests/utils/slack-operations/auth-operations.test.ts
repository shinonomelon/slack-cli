import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthOperations } from '../../../src/utils/slack-operations/auth-operations';

vi.mock('@slack/web-api', () => ({
  WebClient: vi.fn().mockImplementation(function () {
    return {
      auth: {
        test: vi.fn(),
      },
    };
  }),
  LogLevel: {
    ERROR: 'error',
  },
}));

describe('AuthOperations', () => {
  type MockClient = {
    auth: {
      test: ReturnType<typeof vi.fn>;
    };
  };

  let authOps: AuthOperations;
  let mockClient: MockClient;

  beforeEach(() => {
    vi.clearAllMocks();
    authOps = new AuthOperations('test-token');
    mockClient = (authOps as unknown as { client: MockClient }).client;
  });

  describe('testAuth', () => {
    it('should return the auth.test response as is', async () => {
      // ユーザーかボットかの判断と出す項目の選択は呼び出し側の仕事なので、応答は加工しない
      const response = {
        ok: true,
        url: 'https://example.slack.com/',
        team: 'Example Team',
        user: 'alice',
        team_id: 'T1234567890',
        user_id: 'U1234567890',
        bot_id: 'B1234567890',
      };
      mockClient.auth.test.mockResolvedValue(response);

      await expect(authOps.testAuth()).resolves.toBe(response);
      expect(mockClient.auth.test).toHaveBeenCalledWith();
    });

    it('should let an auth.test failure propagate', async () => {
      const error = new Error('An API error occurred: invalid_auth');
      mockClient.auth.test.mockRejectedValue(error);

      await expect(authOps.testAuth()).rejects.toBe(error);
    });
  });
});
