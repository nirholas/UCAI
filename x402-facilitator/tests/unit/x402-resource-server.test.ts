import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import { x402PaymentRequired } from '../../src/middleware/x402-resource-server.js';

const paymentRequirements = {
  chainId: 8453 as const,
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const,
  payTo: '0x1111111111111111111111111111111111111111' as const,
  maxAmountRequired: 20_000n,
};

const paymentPayload = {
  x402Version: 1,
  chainId: 8453,
  asset: paymentRequirements.asset,
  authorization: {
    from: '0x2222222222222222222222222222222222222222',
    to: paymentRequirements.payTo,
    value: '20000',
    validAfter: '0',
    validBefore: '2000000000',
    nonce: `0x${'01'.repeat(32)}`,
  },
  signature: `0x${'02'.repeat(65)}`,
};

describe('x402PaymentRequired', () => {
  it('uses the facilitator route field names and serializes bigint requirements', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          valid: true,
          isValid: true,
          payer: paymentPayload.authorization.from,
        })),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          success: true,
          txHash: `0x${'03'.repeat(32)}`,
          transaction: `0x${'03'.repeat(32)}`,
          network: 'base',
          payer: paymentPayload.authorization.from,
        })),
      );

    const app = new Hono();
    app.use('/paid', x402PaymentRequired({
      facilitatorUrl: 'https://facilitator.example',
      paymentRequirements,
      fetchFn,
    }));
    app.get('/paid', (c) => c.json({ ok: true }));

    const response = await app.request('/paid', {
      headers: {
        'x-402-payment': Buffer.from(JSON.stringify(paymentPayload)).toString('base64'),
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(fetchFn).toHaveBeenCalledTimes(2);

    for (const [, init] of fetchFn.mock.calls) {
      expect(JSON.parse(init?.body as string)).toEqual({
        paymentPayload,
        paymentRequirements: {
          ...paymentRequirements,
          maxAmountRequired: '20000',
        },
      });
    }
  });
});
