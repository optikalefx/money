import { amazonAdapter } from './amazon';
import type { RetailerEmailAdapter } from './types';

export type { GmailMessage, ParsedItem, ParsedOrder, RetailerEmailAdapter } from './types';

// Registry of retailer adapters. Add a new store's adapter here to start importing its orders.
export const RETAILER_ADAPTERS: RetailerEmailAdapter[] = [amazonAdapter];
