import type { AuthTestResponse } from '@slack/web-api';
import { BaseSlackClient, SlackClientDependency } from './base-client';

export class AuthOperations extends BaseSlackClient {
  constructor(dependency: SlackClientDependency) {
    super(dependency);
  }

  /**
   * auth.test の応答をそのまま返す。トークンの持ち主がユーザーかボットかの判断と、
   * 出力する項目の選択は、呼び出し側（whoami）が行う。
   */
  async testAuth(): Promise<AuthTestResponse> {
    return await this.client.auth.test();
  }
}
