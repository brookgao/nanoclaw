import { registerChannel, ChannelOpts } from './registry.js';
import { Channel } from '../types.js';

export function createFeishuChannel(_opts: ChannelOpts): Channel | null {
  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  if (!appId || !appSecret) return null;
  // Full impl added in later tasks.
  throw new Error('FeishuChannel not yet implemented');
}

registerChannel('feishu', createFeishuChannel);
