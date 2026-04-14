import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getChannelFactory } from './registry.js';

// Import triggers self-registration
import './feishu.js';

describe('FeishuChannel factory', () => {
  const origEnv = { ...process.env };
  beforeEach(() => {
    delete process.env.FEISHU_APP_ID;
    delete process.env.FEISHU_APP_SECRET;
  });
  afterEach(() => {
    for (const k of ['FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'FEISHU_DOMAIN']) {
      if (origEnv[k] === undefined) delete process.env[k];
      else process.env[k] = origEnv[k];
    }
  });

  it('returns null when FEISHU_APP_ID missing', () => {
    process.env.FEISHU_APP_SECRET = 'secret';
    const factory = getChannelFactory('feishu');
    expect(factory).toBeDefined();
    const channel = factory!({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
    });
    expect(channel).toBeNull();
  });

  it('returns null when FEISHU_APP_SECRET missing', () => {
    process.env.FEISHU_APP_ID = 'cli_xxx';
    const factory = getChannelFactory('feishu');
    const channel = factory!({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
    });
    expect(channel).toBeNull();
  });
});
