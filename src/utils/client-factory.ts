import { getConfigOrThrow } from './config-helper';
import { SlackApiClient } from './slack-api-client';
import type { SlackClientOptions } from './slack-operations/base-client';

/**
 * Creates a SlackApiClient instance with configuration from the specified profile
 */
export async function createSlackClient(
  profile?: string,
  options?: SlackClientOptions
): Promise<SlackApiClient> {
  const config = await getConfigOrThrow(profile);
  // options を省略したときは、今までと同じ呼び方（トークンだけ）にする
  return options ? new SlackApiClient(config.token, options) : new SlackApiClient(config.token);
}
