/**
 * One place that decides how we talk to the model provider. Track A.
 *
 * Lives in /core rather than /scripts because both the corpus pipeline and the
 * app-side renderer need it, and /core is the only directory both may import.
 * It deliberately does NOT load dotenv: /core is bundled into the Next app,
 * where the environment is already populated, and pulling a dotenv side effect
 * into the app bundle would be a script concern leaking into the product.
 *
 * MERGE GATEWAY
 * Gateway sits between us and the model providers: failover when one degrades,
 * plus cost and latency observability across the corpus run, which is by far
 * our largest token spend. Conference wifi is assumed to fail at least once,
 * so provider failover is worth having.
 *
 * It carries NO Article 9 exposure, because it never sees HRIS data. Only model
 * traffic passes through it. That separation is what makes it safe to enable
 * while the Merge HRIS path stays under the strict no-LLM rule documented in
 * docs/TRACK-C-MERGE-BRIEF.md.
 *
 * Unset means talk to Anthropic directly, so nothing changes until keys land.
 */

export interface AnthropicClientOptions {
  apiKey: string;
  baseURL?: string;
}

/** Options for constructing an Anthropic client, routed via Gateway if configured. */
export function anthropicClientOptions(): AnthropicClientOptions {
  const gatewayUrl = process.env.MERGE_GATEWAY_BASE_URL ?? '';
  const gatewayKey = process.env.MERGE_GATEWAY_API_KEY ?? '';
  const anthropicKey = process.env.ANTHROPIC_API_KEY ?? '';

  if (gatewayUrl) {
    // Gateway authenticates with its own key and holds the provider credential.
    // Fall back to the Anthropic key when only the URL has been set.
    return { apiKey: gatewayKey || anthropicKey, baseURL: gatewayUrl };
  }
  return { apiKey: anthropicKey };
}

/**
 * Whether a live model call is possible at all.
 *
 * True when either credential path is available: a direct Anthropic key, or a
 * Gateway base URL, since Gateway can hold the provider credential itself.
 */
export function hasModelCredentials(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.MERGE_GATEWAY_BASE_URL);
}
