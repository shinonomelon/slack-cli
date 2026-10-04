import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SearchOperations } from '../../../src/utils/slack-operations/search-operations';

vi.mock('@slack/web-api', () => ({
  WebClient: vi.fn().mockImplementation(function () {
    return {
      search: {
        messages: vi.fn(),
      },
      auth: {
        test: vi.fn(),
      },
    };
  }),
  LogLevel: {
    ERROR: 'error',
  },
}));

describe('SearchOperations', () => {
  type MockClient = {
    search: {
      messages: ReturnType<typeof vi.fn>;
    };
    auth: {
      test: ReturnType<typeof vi.fn>;
    };
  };

  let searchOps: SearchOperations;
  let mockClient: MockClient;

  beforeEach(() => {
    vi.clearAllMocks();
    searchOps = new SearchOperations('test-token');
    mockClient = (searchOps as unknown as { client: MockClient }).client;
  });

  describe('searchMessages', () => {
    it('should call search.messages with query', async () => {
      mockClient.search.messages.mockResolvedValue({
        ok: true,
        query: 'deploy error',
        messages: {
          matches: [
            {
              text: 'deploy error occurred',
              user: 'U123',
              username: 'john.doe',
              ts: '1609459200.000100',
              channel: { id: 'C123', name: 'general' },
              permalink: 'https://slack.com/archives/C123/p1609459200000100',
            },
          ],
          pagination: {
            total_count: 1,
            page: 1,
            page_count: 1,
          },
        },
      });

      const result = await searchOps.searchMessages('deploy error');

      expect(mockClient.search.messages).toHaveBeenCalledWith({
        query: 'deploy error',
        sort: 'score',
        sort_dir: 'desc',
        count: 20,
        page: 1,
      });
      expect(result.query).toBe('deploy error');
      expect(result.matches).toHaveLength(1);
      expect(result.matches[0].text).toBe('deploy error occurred');
      expect(result.matches[0].channel.name).toBe('general');
      expect(result.totalCount).toBe(1);
    });

    it('should pass sort and pagination options', async () => {
      mockClient.search.messages.mockResolvedValue({
        ok: true,
        query: 'test',
        messages: {
          matches: [],
          pagination: { total_count: 0, page: 1, page_count: 0 },
        },
      });

      await searchOps.searchMessages('test', {
        sort: 'timestamp',
        sortDir: 'asc',
        count: 50,
        page: 2,
      });

      expect(mockClient.search.messages).toHaveBeenCalledWith({
        query: 'test',
        sort: 'timestamp',
        sort_dir: 'asc',
        count: 50,
        page: 2,
      });
    });

    it('should return empty matches when no results found', async () => {
      mockClient.search.messages.mockResolvedValue({
        ok: true,
        query: 'nonexistent',
        messages: {
          matches: [],
          pagination: { total_count: 0, page: 1, page_count: 0 },
        },
      });

      const result = await searchOps.searchMessages('nonexistent');

      expect(result.matches).toHaveLength(0);
      expect(result.totalCount).toBe(0);
    });

    it('should handle multiple matches with channel info', async () => {
      mockClient.search.messages.mockResolvedValue({
        ok: true,
        query: 'meeting',
        messages: {
          matches: [
            {
              text: 'Meeting at 3pm',
              user: 'U123',
              username: 'alice',
              ts: '1609459200.000100',
              channel: { id: 'C123', name: 'general' },
              permalink: 'https://slack.com/archives/C123/p1609459200000100',
            },
            {
              text: 'Meeting notes attached',
              user: 'U456',
              username: 'bob',
              ts: '1609459300.000200',
              channel: { id: 'C456', name: 'dev' },
              permalink: 'https://slack.com/archives/C456/p1609459300000200',
            },
          ],
          pagination: { total_count: 2, page: 1, page_count: 1 },
        },
      });

      const result = await searchOps.searchMessages('meeting');

      expect(result.matches).toHaveLength(2);
      expect(result.matches[0].username).toBe('alice');
      expect(result.matches[1].channel.name).toBe('dev');
      expect(result.totalCount).toBe(2);
      expect(result.page).toBe(1);
      expect(result.pageCount).toBe(1);
    });

    it('should handle missing optional fields gracefully', async () => {
      mockClient.search.messages.mockResolvedValue({
        ok: true,
        query: 'test',
        messages: {
          matches: [
            {
              text: 'A message',
              ts: '1609459200.000100',
              channel: { id: 'C123' },
            },
          ],
          pagination: { total_count: 1, page: 1, page_count: 1 },
        },
      });

      const result = await searchOps.searchMessages('test');

      expect(result.matches).toHaveLength(1);
      expect(result.matches[0].username).toBeUndefined();
      expect(result.matches[0].channel.name).toBeUndefined();
    });

    it('should return the Slack matches unchanged as rawMatches', async () => {
      // matches が捨てる項目（is_im・添付・thread_ts 付きの permalink など）を含む生の結果
      const slackMatches = [
        {
          iid: 'a1b2c3',
          team: 'T123',
          type: 'message',
          text: 'hello <@U456>',
          user: 'U123',
          username: 'john.doe',
          ts: '1609459200.000100',
          channel: {
            id: 'D123',
            name: 'U456',
            is_channel: false,
            is_group: false,
            is_im: true,
            is_mpim: false,
            is_private: true,
          },
          permalink:
            'https://slack.com/archives/D123/p1609459200000100?thread_ts=1609459100.000200&cid=D123',
          attachments: [{ fallback: 'attachment text' }],
        },
      ];
      mockClient.search.messages.mockResolvedValue({
        ok: true,
        query: 'hello',
        messages: {
          matches: slackMatches,
          pagination: { total_count: 1, page: 1, page_count: 1 },
        },
      });

      const result = await searchOps.searchMessages('hello');

      expect(result.rawMatches).toEqual(slackMatches);
      expect(result.rawMatches[0]).toHaveProperty('channel.is_im', true);
      expect(result.rawMatches[0]).toHaveProperty('attachments');
    });

    it('should keep the shaped matches as they were when rawMatches is added', async () => {
      mockClient.search.messages.mockResolvedValue({
        ok: true,
        query: 'hello',
        messages: {
          matches: [
            {
              iid: 'a1b2c3',
              type: 'message',
              text: 'hello',
              user: 'U123',
              username: 'john.doe',
              ts: '1609459200.000100',
              channel: { id: 'D123', name: 'U456', is_im: true, is_private: true },
              permalink: 'https://slack.com/archives/D123/p1609459200000100',
              attachments: [{ fallback: 'attachment text' }],
            },
          ],
          pagination: { total_count: 1, page: 1, page_count: 1 },
        },
      });

      const result = await searchOps.searchMessages('hello');

      expect(result.matches).toEqual([
        {
          text: 'hello',
          user: 'U123',
          username: 'john.doe',
          ts: '1609459200.000100',
          channel: { id: 'D123', name: 'U456' },
          permalink: 'https://slack.com/archives/D123/p1609459200000100',
        },
      ]);
    });

    it('should return empty matches and rawMatches when the response has no messages', async () => {
      mockClient.search.messages.mockResolvedValue({ ok: true, query: 'test' });

      const result = await searchOps.searchMessages('test');

      expect(result.matches).toEqual([]);
      expect(result.rawMatches).toEqual([]);
      expect(result.totalCount).toBe(0);
    });
  });

  describe('getAuthenticatedUserId', () => {
    it('should return the user id from auth.test', async () => {
      mockClient.auth.test.mockResolvedValue({ ok: true, user_id: 'UME' });

      await expect(searchOps.getAuthenticatedUserId()).resolves.toBe('UME');
    });
  });

  describe('listMessagesToUser', () => {
    it('should search DMs and mentions, skip own messages, and merge duplicates', async () => {
      mockClient.search.messages
        .mockResolvedValueOnce({
          messages: {
            matches: [
              { ts: '100.1', user: 'U1', channel: { id: 'D1', name: 'U1', is_im: true } },
              { ts: '100.2', user: 'UME', channel: { id: 'D1', name: 'U1', is_im: true } },
            ],
            pagination: { page_count: 1 },
          },
        })
        .mockResolvedValueOnce({
          messages: {
            matches: [
              { ts: '100.1', user: 'U1', channel: { id: 'D1', name: 'U1', is_im: true } },
              { ts: '200.1', user: 'U2', channel: { id: 'C1', name: 'general' } },
            ],
            pagination: { page_count: 1 },
          },
        });

      const result = await searchOps.listMessagesToUser('UME', '2026-09-27');

      expect(mockClient.search.messages).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ query: 'is:dm after:2026-09-27' })
      );
      expect(mockClient.search.messages).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ query: '<@UME> after:2026-09-27' })
      );
      expect(result.map((r) => [r.channel.id, r.timestamps])).toEqual([
        ['D1', ['100.1']],
        ['C1', ['200.1']],
      ]);
      expect(result[0].channel.is_im).toBe(true);
    });

    it('should stop paging after the maximum number of pages', async () => {
      mockClient.search.messages.mockResolvedValue({
        messages: { matches: [], pagination: { page_count: 20 } },
      });

      await searchOps.listMessagesToUser('UME', '2026-09-27');

      // 2 queries x 5 pages
      expect(mockClient.search.messages).toHaveBeenCalledTimes(10);
    });
  });

  describe('listUnreadChannels', () => {
    it('should aggregate unread counts by channel across pages', async () => {
      mockClient.search.messages
        .mockResolvedValueOnce({
          ok: true,
          messages: {
            matches: [
              {
                ts: '1700000002.000200',
                channel: { id: 'C123', name: 'general', is_channel: true, is_private: false },
              },
              {
                ts: '1700000001.000100',
                channel: { id: 'C123', name: 'general', is_channel: true, is_private: false },
              },
            ],
            pagination: { page_count: 2 },
          },
        })
        .mockResolvedValueOnce({
          ok: true,
          messages: {
            matches: [
              {
                ts: '1699999999.000300',
                channel: { id: 'C456', name: 'random', is_channel: true, is_private: true },
              },
            ],
            pagination: { page_count: 2 },
          },
        });

      const result = await searchOps.listUnreadChannels();

      expect(mockClient.search.messages).toHaveBeenNthCalledWith(1, {
        query: 'is:unread',
        sort: 'timestamp',
        sort_dir: 'desc',
        count: 100,
        page: 1,
      });
      expect(mockClient.search.messages).toHaveBeenNthCalledWith(2, {
        query: 'is:unread',
        sort: 'timestamp',
        sort_dir: 'desc',
        count: 100,
        page: 2,
      });
      expect(result).toEqual([
        expect.objectContaining({
          id: 'C123',
          name: 'general',
          unread_count: 2,
          unread_count_display: 2,
          last_read: '1700000002.000200',
        }),
        expect.objectContaining({
          id: 'C456',
          name: 'random',
          unread_count: 1,
          unread_count_display: 1,
          last_read: '1699999999.000300',
          is_private: true,
        }),
      ]);
    });

    it('should ignore matches without channel ids', async () => {
      mockClient.search.messages.mockResolvedValue({
        ok: true,
        messages: {
          matches: [{ ts: '1700000000.000100', channel: { name: 'general' } }],
          pagination: { page_count: 1 },
        },
      });

      const result = await searchOps.listUnreadChannels();

      expect(result).toEqual([]);
    });
  });
});
