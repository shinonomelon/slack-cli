import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSearchFormatter,
  SearchFormatterOptions,
} from '../../../src/utils/formatters/search-formatters';
import { SearchMatch } from '../../../src/utils/slack-api-client';

describe('SearchFormatters', () => {
  let mockConsole: ReturnType<typeof vi.spyOn>;

  const createMatches = (): SearchMatch[] => [
    {
      text: 'deploy error occurred in production',
      user: 'U123',
      username: 'john.doe',
      ts: '1609459200.000100',
      channel: { id: 'C123', name: 'general' },
      permalink: 'https://slack.com/archives/C123/p1609459200000100',
    },
    {
      text: 'fixed the deploy error from yesterday',
      user: 'U456',
      username: 'jane.smith',
      ts: '1609459300.000200',
      channel: { id: 'C456', name: 'dev' },
      permalink: 'https://slack.com/archives/C456/p1609459300000200',
    },
  ];

  // Slack の search.messages が返す match そのまま（整形済みの matches が捨てる項目を含む）
  const createRawMatches = (): Record<string, unknown>[] => [
    {
      iid: 'a1b2c3',
      team: 'T123',
      type: 'message',
      text: 'deploy error occurred in production',
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

  const createOptions = (overrides?: Partial<SearchFormatterOptions>): SearchFormatterOptions => ({
    query: 'deploy error',
    matches: createMatches(),
    totalCount: 2,
    page: 1,
    pageCount: 1,
    ...overrides,
  });

  beforeEach(() => {
    mockConsole = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  describe('table formatter', () => {
    it('should display search results header with query and count', () => {
      const formatter = createSearchFormatter('table');
      formatter.format(createOptions());

      expect(mockConsole).toHaveBeenCalledWith(expect.stringContaining('deploy error'));
      expect(mockConsole).toHaveBeenCalledWith(expect.stringContaining('2'));
    });

    it('should display channel name and username for each match', () => {
      const formatter = createSearchFormatter('table');
      formatter.format(createOptions());

      expect(mockConsole).toHaveBeenCalledWith(expect.stringContaining('general'));
      expect(mockConsole).toHaveBeenCalledWith(expect.stringContaining('john.doe'));
    });

    it('should display message text', () => {
      const formatter = createSearchFormatter('table');
      formatter.format(createOptions());

      expect(mockConsole).toHaveBeenCalledWith(
        expect.stringContaining('deploy error occurred in production')
      );
    });

    it('should show no results message when matches are empty', () => {
      const formatter = createSearchFormatter('table');
      formatter.format(createOptions({ matches: [], totalCount: 0 }));

      expect(mockConsole).toHaveBeenCalledWith(expect.stringContaining('No messages found'));
    });

    it('should show page info when multiple pages exist', () => {
      const formatter = createSearchFormatter('table');
      formatter.format(createOptions({ totalCount: 50, page: 2, pageCount: 3 }));

      expect(mockConsole).toHaveBeenCalledWith(expect.stringContaining('Page 2/3'));
    });
  });

  describe('simple formatter', () => {
    it('should display matches in single-line format', () => {
      const formatter = createSearchFormatter('simple');
      formatter.format(createOptions());

      expect(mockConsole).toHaveBeenCalledWith(
        expect.stringMatching(/\[#general\].*john\.doe.*deploy error occurred/)
      );
    });

    it('should show no results message when matches are empty', () => {
      const formatter = createSearchFormatter('simple');
      formatter.format(createOptions({ matches: [], totalCount: 0 }));

      expect(mockConsole).toHaveBeenCalledWith(expect.stringContaining('No messages found'));
    });
  });

  describe('json formatter', () => {
    it('should output valid JSON with all fields', () => {
      const formatter = createSearchFormatter('json');
      formatter.format(createOptions());

      const jsonCall = mockConsole.mock.calls.find((call: unknown[]) => {
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

      expect(jsonCall).toBeDefined();
      const output = JSON.parse(jsonCall[0]);
      expect(output.query).toBe('deploy error');
      expect(output.totalCount).toBe(2);
      expect(output.matches).toHaveLength(2);
      expect(output.matches[0].channel).toBe('general');
      expect(output.matches[0].username).toBe('john.doe');
      expect(output.matches[0].permalink).toBe('https://slack.com/archives/C123/p1609459200000100');
    });

    it('should not change its output when rawMatches is also passed', () => {
      const formatter = createSearchFormatter('json');
      // beforeEach はスパイを作り直すだけで呼び出しの記録を消さないので、ここで消す
      mockConsole.mockClear();
      formatter.format(createOptions());
      const withoutRaw = mockConsole.mock.calls[0][0];

      mockConsole.mockClear();
      formatter.format(createOptions({ rawMatches: createRawMatches() }));

      expect(mockConsole).toHaveBeenCalledTimes(1);
      expect(mockConsole.mock.calls[0][0]).toBe(withoutRaw);
    });
  });

  describe('raw formatter', () => {
    beforeEach(() => {
      // 前のテストの呼び出しの記録を引き継がない（出力が1回だけであることも確かめるため）
      mockConsole.mockClear();
    });

    it('should print the raw matches as they are', () => {
      const rawMatches = createRawMatches();
      const formatter = createSearchFormatter('raw');
      formatter.format(createOptions({ rawMatches, totalCount: 1 }));

      expect(mockConsole).toHaveBeenCalledTimes(1);
      const output = JSON.parse(mockConsole.mock.calls[0][0]);
      expect(output.matches).toEqual(rawMatches);
      expect(output.matches[0].channel.is_im).toBe(true);
      expect(output.matches[0].attachments).toEqual([{ fallback: 'attachment text' }]);
    });

    it('should print the same top-level keys in the same order as json, indented the same way', () => {
      const rawMatches = createRawMatches();
      const formatter = createSearchFormatter('raw');
      formatter.format(
        createOptions({ query: 'hello', rawMatches, totalCount: 40, page: 2, pageCount: 4 })
      );

      const printed = mockConsole.mock.calls[0][0];
      expect(Object.keys(JSON.parse(printed))).toEqual([
        'query',
        'totalCount',
        'page',
        'pageCount',
        'matches',
      ]);
      expect(printed).toBe(
        JSON.stringify(
          { query: 'hello', totalCount: 40, page: 2, pageCount: 4, matches: rawMatches },
          null,
          2
        )
      );
    });

    it('should not use the shaped matches', () => {
      const formatter = createSearchFormatter('raw');
      formatter.format(createOptions({ rawMatches: createRawMatches() }));

      const output = JSON.parse(mockConsole.mock.calls[0][0]);
      // 整形済みの matches（2件）ではなく、rawMatches（1件）が出る
      expect(output.matches).toHaveLength(1);
      expect(output.matches[0]).not.toHaveProperty('timestamp');
    });

    it('should print an empty matches array when there are no matches', () => {
      const formatter = createSearchFormatter('raw');
      formatter.format(createOptions({ matches: [], rawMatches: [], totalCount: 0, pageCount: 0 }));

      const output = JSON.parse(mockConsole.mock.calls[0][0]);
      expect(output.matches).toEqual([]);
      expect(output.totalCount).toBe(0);
    });

    it('should strip terminal control sequences inside the raw matches', () => {
      const rawMatches = [
        {
          ...createRawMatches()[0],
          text: 'plain \u001b[31mred\u001b[0m text\u0007',
          channel: { id: 'C123', name: 'gen\u001b]0;title\u0007eral' },
        },
      ];
      const formatter = createSearchFormatter('raw');
      formatter.format(createOptions({ rawMatches, totalCount: 1 }));

      const output = JSON.parse(mockConsole.mock.calls[0][0]);
      expect(output.matches[0].text).toBe('plain red text');
      expect(output.matches[0].channel.name).toBe('general');
    });
  });

  describe('default formatter', () => {
    it('should fallback to table format for unknown format', () => {
      const formatter = createSearchFormatter('unknown');
      formatter.format(createOptions());

      // Should not throw and should output something
      expect(mockConsole).toHaveBeenCalled();
    });
  });
});
