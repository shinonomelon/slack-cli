import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Channel } from '../../../src/types/slack';
import { createChannelFormatter } from '../../../src/utils/formatters/channel-formatters';

describe('channel formatters', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('json format', () => {
    it('should include userId only for direct messages', () => {
      const channels = [
        { id: 'C123', name: 'general', is_channel: true, unread_count: 2 },
        { id: 'D456', name: 'U789', is_im: true, user: 'U789', unread_count: 1 },
      ] as Channel[];

      createChannelFormatter('json', false).format({ channels });

      expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toEqual([
        { channel: '#general', channelId: 'C123', unreadCount: 2 },
        { channel: '#U789', channelId: 'D456', unreadCount: 1, userId: 'U789' },
      ]);
    });
  });
});
