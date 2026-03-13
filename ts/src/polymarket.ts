/// <reference lib="es2015" />
// ---------------------------------------------------------------------------
//
// Polymarket CCXT Exchange adapter
//
// Maps Polymarket prediction market structure to CCXT unified interface:
//   Event → groups of related Markets
//   Market → a specific question (e.g. "Will X happen?")
//   Outcome token → CCXT Market (the actual tradeable instrument)
//
// Each outcome token (YES/NO/etc.) becomes one CCXT market:
//   id:     CLOB token ID  (used for all order-book / trade calls)
//   symbol: {conditionId}/{outcomeLabel}:USDC
//
// ---------------------------------------------------------------------------

import Exchange from './abstract/polymarket.js';
import { sha256 } from './static_dependencies/noble-hashes/sha256.js';
import type {
    Int, Str, Num, Dict,
    Market, Ticker, Tickers, OrderBook, Trade, OHLCV,
    Order, Balances, Position,
} from './base/types.js';

// ---------------------------------------------------------------------------

/**
 * @class polymarket
 * @augments Exchange
 */
export default class polymarket extends Exchange {

    describe () {
        return this.deepExtend (super.describe (), {
            'id': 'polymarket',
            'name': 'Polymarket',
            'countries': ['US'],
            'rateLimit': 100,
            'certified': false,
            'pro': false,
            'has': {
                'CORS': undefined,
                'spot': false,
                'margin': false,
                'swap': false,
                'future': false,
                'option': false,
                'prediction': true,         // Prediction market support
                'fetchEvents': true,        // Custom: fetch Polymarket events
                'fetchMarkets': true,       // Each outcome token = one market
                'fetchTicker': true,
                'fetchTickers': true,
                'fetchOrderBook': true,
                'fetchTrades': true,
                'fetchOHLCV': true,
                'fetchBalance': true,
                'fetchPositions': true,
                'fetchOpenOrders': true,
                'fetchOrder': true,
                'createOrder': true,
                'cancelOrder': true,
                'cancelAllOrders': true,
                'fetchCurrencies': false,
                'fetchDeposits': false,
                'fetchWithdrawals': false,
                'fetchMyTrades': false,
                'fetchLedger': false,
            },
            'timeframes': {
                '1m':  '1',
                '5m':  '5',
                '1h':  '60',
                '6h':  '360',
                '1d':  '1440',
            },
            'urls': {
                'logo': 'https://polymarket.com/favicon.ico',
                'api': {
                    'gamma': 'https://gamma-api.polymarket.com',
                    'clob':  'https://clob.polymarket.com',
                    'data':  'https://data-api.polymarket.com',
                },
                'www':  'https://polymarket.com',
                'doc':  ['https://docs.polymarket.com'],
                'fees': 'https://docs.polymarket.com/#fees',
            },
            'api': {
                'gamma': {
                    'public': {
                        'get': {
                            'events':                1,
                            'events/{id}':           1,
                            'events/slug/{slug}':    1,
                            'markets':               1,
                            'markets/{id}':          1,
                            'public-search':         1,
                        },
                    },
                },
                'clob': {
                    'public': {
                        'get': {
                            'book':              1,
                            'prices-history':    1,
                            'data/trades':       1,
                            'price':             1,
                            'midpoint':          1,
                            'spread':            1,
                        },
                    },
                    'private': {
                        'get': {
                            'data/orders':       1,
                            'data/order/{id}':   1,
                        },
                        'post': {
                            'order':             1,
                        },
                        'delete': {
                            'order':             1,
                            'orders':            1,
                        },
                    },
                },
                'data': {
                    'private': {
                        'get': {
                            'positions':   1,
                            'trades':      1,
                            'value':       1,
                        },
                    },
                },
            },
            'requiredCredentials': {
                'apiKey':        true,   // POLY_API_KEY
                'secret':        true,   // POLY_API_SECRET
                'password':      true,   // POLY_PASSPHRASE
                'walletAddress': true,   // Ethereum wallet address
            },
            'fees': {
                'trading': {
                    'tierBased':   false,
                    'percentage':  true,
                    'maker':       0.0,
                    'taker':       0.0,
                },
            },
            'options': {
                'defaultFetchEventsLimit':  100,
                'maxFetchEventsLimit':      500,
                'defaultEventStatus':       'active',  // 'active' | 'closed' | 'all'
            },
        });
    }

    // -----------------------------------------------------------------------
    // Market loading — each Polymarket outcome token becomes one CCXT market
    // -----------------------------------------------------------------------

    async fetchMarkets (params: Dict = {}): Promise<Market[]> {
        /**
         * Fetches all active Polymarket events → markets → outcomes,
         * flattens them into the CCXT market list, and stores a nested
         * events dict at this.events keyed by normalised event slug.
         *
         * Each outcome token becomes one CCXT market:
         *   symbol  = EVENT_SLUG:MARKET_SLUG:OUTCOME  (e.g. "US_ELECTION_2028:TRUMP:YES")
         *   id      = clobTokenId  (the actual CLOB order-book identifier)
         */
        const pageSize = this.safeInteger (this.options, 'maxFetchEventsLimit', 500);
        const maxPages = 20;
        const status = this.safeString (params, 'status', this.safeString (this.options, 'defaultEventStatus', 'active'));
        const rest = this.omit (params, [ 'status' ]);
        const baseRequest: Dict = this.extend ({ 'limit': pageSize, 'order': 'volume24hr', 'ascending': false }, rest);
        if (status === 'active') {
            baseRequest['active'] = true;
        } else if (status === 'closed') {
            baseRequest['closed'] = true;
        }
        // Fetch page 1 first; if full, fire remaining pages in parallel
        const firstPage = ((await this.gammaPublicGetEvents (this.extend ({ 'offset': 0 }, baseRequest))) || []) as any[];
        let allRawEvents = firstPage;
        if (firstPage.length >= pageSize) {
            const offsets: number[] = [];
            for (let p = 1; p < maxPages; p++) {
                offsets.push (p * pageSize);
            }
            const restPages = await Promise.all (offsets.map ((off) => this.gammaPublicGetEvents (this.extend ({ 'offset': off }, baseRequest)).then ((r: any) => r || [])));
            allRawEvents = (firstPage as any[]).concat ((restPages as any[][]).flat ());
        }
        const flatMarkets: Market[] = [];
        const eventsDict: Dict = {};
        for (const rawEvent of allRawEvents) {
            const ccxtMarkets = this.parseEventToMarkets (rawEvent);
            for (const m of ccxtMarkets) {
                flatMarkets.push (m);
            }
            const parsedEvent = this.parseEvent (rawEvent, ccxtMarkets);
            const eventSlug = this.safeString (rawEvent, 'slug');
            if (eventSlug) {
                const eventKey = this.shortenSlug (eventSlug as string);
                eventsDict[eventKey] = parsedEvent;
            }
        }
        this.events = eventsDict;
        return flatMarkets;
    }

    parseEventToMarkets (event: Dict): Market[] {
        /**
         * Converts one Polymarket event (with nested markets and outcomes)
         * into a flat array of CCXT markets — one per polymarket market.
         * Each CCXT market contains an `outcomes` array with one entry per outcome token.
         */
        const eventSlug     = this.safeString (event, 'slug', this.safeString (event, 'id'));
        const rawMarkets    = (this.safeList (event, 'markets', []) || []) as any[];
        const result: Market[] = [];

        for (let mi = 0; mi < rawMarkets.length; mi++) {
            const market      = rawMarkets[mi];
            const conditionId = this.safeString (market, 'conditionId');
            const marketId    = this.safeString (market, 'id');
            const marketSlug  = this.safeString (market, 'slug', conditionId);
            const active      = this.safeBool   (market, 'active', false);
            const closed      = this.safeBool   (market, 'closed', false);
            const tickSize    = this.safeNumber  (market, 'minimumTickSize', 0.01);
            const endDate     = this.safeString  (market, 'endDate', this.safeString (market, 'end_date_iso'));

            // Gamma API returns these arrays as JSON-encoded strings
            let outcomeLabels: string[]  = [];
            let clobTokenIds: string[]   = [];
            let outcomePrices: string[]  = [];

            const parsedOutcomes = this.parseJson (this.safeString (market, 'outcomes',      '[]'));
            const parsedTokenIds = this.parseJson (this.safeString (market, 'clobTokenIds',  '[]'));
            const parsedPrices   = this.parseJson (this.safeString (market, 'outcomePrices', '[]'));

            if (parsedOutcomes && (parsedOutcomes as any[]).length !== undefined) {
                outcomeLabels = parsedOutcomes as string[];
            }
            if (parsedTokenIds && (parsedTokenIds as any[]).length !== undefined) {
                clobTokenIds = parsedTokenIds as string[];
            }
            if (parsedPrices && (parsedPrices as any[]).length !== undefined) {
                outcomePrices = parsedPrices as string[];
            }

            if (outcomeLabels.length === 0 || clobTokenIds.length === 0) {
                continue;
            }

            // Market symbol (no outcome suffix)
            const marketSymbol = this.slugToMarketSymbol (eventSlug, marketSlug);

            // Build outcomes array
            const outcomes: any[] = [];
            for (let oi = 0; oi < outcomeLabels.length; oi++) {
                const outcomeLabel = outcomeLabels[oi];
                const clobTokenId  = clobTokenIds[oi];
                const outcomePrice = this.safeNumber (outcomePrices as any, oi as any);

                if (!clobTokenId) {
                    continue;
                }

                outcomes.push ({
                    'id':           clobTokenId,
                    'symbol':       marketSymbol + ':' + outcomeLabel.toUpperCase (),
                    'marketSymbol': marketSymbol,
                    'label':        outcomeLabel,
                    'price':        outcomePrice,
                    'active':       active && !closed,
                    'info':         market,
                });
            }

            result.push ({
                'id':              conditionId || marketId,
                'symbol':          marketSymbol,
                'base':            'USDC',
                'quote':           'USDC',
                'settle':          undefined,
                'baseId':          conditionId || marketId,
                'quoteId':         'USDC',
                'settleId':        undefined,
                'type':            'prediction',
                'spot':            false,
                'margin':          false,
                'swap':            false,
                'future':          false,
                'option':          false,
                'prediction':      true,
                'active':          active && !closed,
                'contract':        false,
                'linear':          undefined,
                'inverse':         undefined,
                'contractSize':    undefined,
                'expiry':          endDate ? this.parse8601 (endDate) : undefined,
                'expiryDatetime':  endDate,
                'strike':          undefined,
                'optionType':      undefined,
                'taker':           0.0,
                'maker':           0.0,
                'percentage':      true,
                'tierBased':       false,
                'feeSide':         'get',
                'precision': {
                    'amount':  tickSize,
                    'price':   tickSize,
                },
                'limits': {
                    'leverage':  { 'min': 1,    'max': 1        },
                    'amount':    { 'min': 1,    'max': undefined },
                    'price':     { 'min': 0.01, 'max': 0.99     },
                    'cost':      { 'min': undefined, 'max': undefined },
                },
                'outcomes':  outcomes,
                'info':      market,
                'created':   undefined,
            } as unknown as Market);
        }
        return result;
    }

    // -----------------------------------------------------------------------
    // Ticker — price data for one outcome token
    // -----------------------------------------------------------------------

    async fetchTicker (outcome: Str, params: Dict = {}): Promise<Ticker> {
        await this.loadMarkets ();
        const outcomeObj = this.outcome (outcome);
        const tokenId = outcomeObj['id'] as string;

        // Sequential to avoid Promise.all (not in lib scope)
        const midpointResponse = await this.clobPublicGetMidpoint ({ 'token_id': tokenId });
        const bookResponse = await this.clobPublicGetBook ({ 'token_id': tokenId });

        return this.parseTicker (
            { 'midpoint': midpointResponse, 'book': bookResponse },
            outcomeObj as any
        );
    }

    async fetchTickers (outcomes?: Str[], params: Dict = {}): Promise<Tickers> {
        await this.loadMarkets ();
        const targets: string[] = outcomes ? (outcomes as string[]) : Object.keys (this.outcomes || {});
        const result: Tickers = {};
        for (const outcomeSymbol of targets) {
            const ticker = await this.fetchTicker (outcomeSymbol, params);
            result[outcomeSymbol] = ticker;
        }
        return result;
    }

    parseTicker (ticker: Dict, market: Market = undefined): Ticker {
        const midpointData = this.safeValue (ticker, 'midpoint', {});
        const bookData     = this.safeValue (ticker, 'book', {});

        const mid  = this.safeNumber (midpointData, 'mid');

        const bids    = (this.safeList (bookData, 'bids', []) || []) as any[];
        const asks    = (this.safeList (bookData, 'asks', []) || []) as any[];
        const bestBid = bids.length ? this.safeNumber (bids[0], 'price') : undefined;
        const bestAsk = asks.length ? this.safeNumber (asks[0], 'price') : undefined;

        const symbol = this.safeSymbol (undefined, market);
        const now    = this.milliseconds ();

        return this.safeTicker ({
            'symbol':        symbol,
            'timestamp':     now,
            'datetime':      this.iso8601 (now),
            'high':          undefined,
            'low':           undefined,
            'bid':           bestBid,
            'bidVolume':     bids.length ? this.safeNumber (bids[0], 'size') : undefined,
            'ask':           bestAsk,
            'askVolume':     asks.length ? this.safeNumber (asks[0], 'size') : undefined,
            'vwap':          undefined,
            'open':          undefined,
            'close':         mid,
            'last':          mid,
            'previousClose': undefined,
            'change':        undefined,
            'percentage':    undefined,
            'average':       mid,
            'baseVolume':    undefined,
            'quoteVolume':   market ? this.safeNumber (market['info'], 'volume24h') : undefined,
            'info':          ticker,
        }, market);
    }

    // -----------------------------------------------------------------------
    // Order book — CLOB order book for one outcome token
    // -----------------------------------------------------------------------

    async fetchOrderBook (outcome: Str, limit: Int = undefined, params: Dict = {}): Promise<OrderBook> {
        await this.loadMarkets ();
        const outcomeObj = this.outcome (outcome);
        const tokenId = outcomeObj['id'] as string;

        const response = await this.clobPublicGetBook (this.extend ({
            'token_id': tokenId,
        }, params));

        const timestamp = this.milliseconds ();
        return this.parseOrderBook (response, outcome, timestamp, 'bids', 'asks', 'price', 'size');
    }

    // -----------------------------------------------------------------------
    // OHLCV — price history for one outcome token
    // -----------------------------------------------------------------------

    async fetchOHLCV (outcome: Str, timeframe = '1m', since: Int = undefined, limit: Int = undefined, params: Dict = {}): Promise<OHLCV[]> {
        await this.loadMarkets ();
        const outcomeObj = this.outcome (outcome);
        const tokenId  = outcomeObj['id'] as string;
        const fidelity = this.safeString (this.timeframes, timeframe, '1');

        const request: Dict = {
            'market':   tokenId,
            'fidelity': fidelity,
        };

        if (since !== undefined) {
            request['startTs'] = this.parseToInt (since / 1000);
        }
        if (limit !== undefined && since !== undefined) {
            const tf   = this.parseTimeframe (timeframe);
            const endS = (since / 1000) + limit * tf;
            const nowS = this.seconds ();
            request['endTs'] = endS < nowS ? endS : nowS;
        }

        const response = await this.clobPublicGetPricesHistory (this.extend (request, params));
        const history  = (this.safeList (response, 'history', []) || []) as any[];

        return this.parseOHLCVs (history, outcomeObj as any, timeframe, since, limit);
    }

    parseOHLCV (ohlcv: Dict, market: Market = undefined): OHLCV {
        // Polymarket prices-history tick: { t: unix_seconds, p: price }
        const ts    = this.safeInteger (ohlcv, 't');
        const price = this.safeNumber  (ohlcv, 'p');
        return [
            ts !== undefined ? ts * 1000 : undefined,
            price,   // open  (raw tick — no OHLCV disaggregation available)
            price,   // high
            price,   // low
            price,   // close
            undefined, // volume (not provided per-tick)
        ];
    }

    // -----------------------------------------------------------------------
    // Trades — public trade history for one outcome token
    // -----------------------------------------------------------------------

    async fetchTrades (outcome: Str, since: Int = undefined, limit: Int = undefined, params: Dict = {}): Promise<Trade[]> {
        await this.loadMarkets ();
        const outcomeObj = this.outcome (outcome);
        const tokenId = outcomeObj['id'] as string;

        const request: Dict = { 'asset_id': tokenId };
        if (limit !== undefined) {
            request['limit'] = limit;
        }

        const response = await this.clobPublicGetDataTrades (this.extend (request, params));
        const trades   = (this.safeList (response, 'data', []) || []) as any[];

        return this.parseTrades (trades, outcomeObj as any, since, limit);
    }

    parseTrade (trade: Dict, market: Market = undefined): Trade {
        const id        = this.safeString  (trade, 'id');
        const timestamp = this.safeIntegerProduct (trade, 'timestamp', 1000);
        const price     = this.safeNumber  (trade, 'price');
        const amount    = this.safeNumber  (trade, 'size');
        const rawSide   = this.safeStringLower (trade, 'side');
        const side      = (rawSide === 'buy' || rawSide === 'sell') ? rawSide : undefined;
        const symbol    = this.safeSymbol (undefined, market);

        return this.safeTrade ({
            'id':           id,
            'info':         trade,
            'timestamp':    timestamp,
            'datetime':     this.iso8601 (timestamp),
            'symbol':       symbol,
            'order':        this.safeString (trade, 'orderId'),
            'type':         undefined,
            'side':         side,
            'takerOrMaker': undefined,
            'price':        price,
            'amount':       amount,
            'cost':         (price !== undefined && amount !== undefined) ? price * amount : undefined,
            'fee':          undefined,
        }, market);
    }

    // -----------------------------------------------------------------------
    // Balance — USDC balance from Data API
    // -----------------------------------------------------------------------

    async fetchBalance (params: Dict = {}): Promise<Balances> {
        this.checkRequiredCredentials ();
        const response = await this.dataPrivateGetValue (this.extend ({
            'user': this.walletAddress,
        }, params));

        return this.parseBalance (response);
    }

    parseBalance (response: Dict): Balances {
        const result: Dict = { 'info': response };
        const total = this.safeNumber (response, 'value', this.safeNumber (response, 'total'));

        result['USDC'] = {
            'free':  total,
            'used':  0,
            'total': total,
        };
        return result as Balances;
    }

    // -----------------------------------------------------------------------
    // Positions — open positions for the authenticated user
    // -----------------------------------------------------------------------

    async fetchPositions (outcomes?: Str[], params: Dict = {}): Promise<Position[]> {
        this.checkRequiredCredentials ();
        const response = await this.dataPrivateGetPositions (this.extend ({
            'user': this.walletAddress,
        }, params));

        const positions = (this.safeList (response, 'data', []) || []) as any[];
        return this.parsePositions (positions, outcomes);
    }

    parsePosition (position: Dict, market: Market = undefined): Position {
        const tokenId    = this.safeString (position, 'asset');
        const marketData = this.safeOutcome (tokenId, market as any);
        const size       = this.safeNumber (position, 'size');
        const entryPrice = this.safeNumber (position, 'avgPrice');
        const curPrice   = this.safeNumber (position, 'currentPrice');

        const unrealizedPnl = (size !== undefined && entryPrice !== undefined && curPrice !== undefined)
            ? size * (curPrice - entryPrice)
            : undefined;

        return {
            'id':                             this.safeString (position, 'id'),
            'symbol':                         marketData['symbol'],
            'timestamp':                      undefined,
            'datetime':                       undefined,
            'contracts':                      size,
            'contractSize':                   1,
            'side':                           'long',
            'notional':                       (size !== undefined && curPrice !== undefined) ? size * curPrice : undefined,
            'leverage':                       1,
            'unrealizedPnl':                  unrealizedPnl,
            'realizedPnl':                    this.safeNumber (position, 'realizedPnl'),
            'collateral':                     undefined,
            'entryPrice':                     entryPrice,
            'markPrice':                      curPrice,
            'liquidationPrice':               undefined,
            'hedged':                         false,
            'maintenanceMargin':              undefined,
            'maintenanceMarginPercentage':    undefined,
            'initialMargin':                  undefined,
            'initialMarginPercentage':        undefined,
            'marginRatio':                    undefined,
            'marginMode':                     'cross',
            'marginType':                     'cross',
            'percentage':                     undefined,
            'info':                           position,
        } as Position;
    }

    // -----------------------------------------------------------------------
    // Orders — authenticated order management
    // -----------------------------------------------------------------------

    async fetchOpenOrders (outcome: Str = undefined, since: Int = undefined, limit: Int = undefined, params: Dict = {}): Promise<Order[]> {
        this.checkRequiredCredentials ();
        const request: Dict = {};
        let outcomeObj: any = undefined;
        if (outcome !== undefined) {
            outcomeObj = this.outcome (outcome);
            request['asset_id'] = outcomeObj['id'];
        }
        const response = await this.clobPrivateGetDataOrders (this.extend (request, params));
        const orders   = (this.safeList (response, 'data', []) || []) as any[];
        return this.parseOrders (orders, outcomeObj as any, since, limit);
    }

    async fetchOrder (id: Str, symbol: Str = undefined, params: Dict = {}): Promise<Order> {
        this.checkRequiredCredentials ();
        const response = await this.clobPrivateGetDataOrderId (this.extend ({ 'id': id }, params));
        return this.parseOrder (response);
    }

    parseOrder (order: Dict, market: Market = undefined): Order {
        const id      = this.safeString (order, 'id');
        const tokenId = this.safeString (order, 'asset_id');
        const mkt     = this.safeOutcome (tokenId, market as any);
        const status  = this.parseOrderStatus (this.safeString (order, 'status'));
        const side    = this.safeStringLower (order, 'side');
        const price   = this.safeNumber (order, 'price');
        const amount  = this.safeNumber (order, 'original_size');
        const filled  = this.safeNumber (order, 'size_matched', 0);
        const remaining = (amount !== undefined && filled !== undefined) ? amount - filled : undefined;
        const ts      = this.safeIntegerProduct (order, 'created_at', 1000);

        return this.safeOrder ({
            'id':                 id,
            'clientOrderId':      undefined,
            'info':               order,
            'timestamp':          ts,
            'datetime':           this.iso8601 (ts),
            'lastTradeTimestamp': undefined,
            'status':             status,
            'symbol':             mkt['symbol'],
            'type':               this.safeStringLower (order, 'type', 'limit'),
            'timeInForce':        this.safeString (order, 'time_in_force', 'GTC'),
            'postOnly':           undefined,
            'side':               side,
            'price':              price,
            'stopPrice':          undefined,
            'triggerPrice':       undefined,
            'average':            undefined,
            'amount':             amount,
            'cost':               undefined,
            'filled':             filled,
            'remaining':          remaining,
            'fee':                undefined,
            'trades':             [],
        }, mkt);
    }

    parseOrderStatus (status: Str): Str {
        const statuses: Dict = {
            'LIVE':      'open',
            'MATCHED':   'closed',
            'CANCELLED': 'canceled',
            'DELAYED':   'open',
        };
        return this.safeString (statuses, status, status);
    }

    async createOrder (outcome: Str, type: Str, side: Str, amount: Num, price: Num = undefined, params: Dict = {}): Promise<Order> {
        this.checkRequiredCredentials ();
        await this.loadMarkets ();
        const outcomeObj = this.outcome (outcome);
        const tokenId = outcomeObj['id'] as string;
        const sideStr = (side as string).toUpperCase ();
        const typeStr = (type as string).toUpperCase ();

        const request: Dict = {
            'token_id': tokenId,
            'price':    price,
            'size':     amount,
            'side':     sideStr,
            'type':     typeStr,
        };

        const response = await this.clobPrivatePostOrder (this.extend (request, params));
        return this.parseOrder (response, outcomeObj as any);
    }

    async cancelOrder (id: Str, symbol: Str = undefined, params: Dict = {}): Promise<Order> {
        this.checkRequiredCredentials ();
        const response = await this.clobPrivateDeleteOrder (this.extend ({ 'order_id': id }, params));
        return this.parseOrder (response);
    }

    async cancelAllOrders (outcome: Str = undefined, params: Dict = {}): Promise<Order[]> {
        this.checkRequiredCredentials ();
        const request: Dict = {};
        if (outcome !== undefined) {
            await this.loadMarkets ();
            const outcomeObj = this.outcome (outcome);
            request['asset_id'] = outcomeObj['id'];
        }
        const response = await this.clobPrivateDeleteOrders (this.extend (request, params));
        return this.parseOrders (response);
    }

    // -----------------------------------------------------------------------
    // Polymarket-specific: fetchEvents
    // Returns raw Polymarket events (with nested markets and outcomes).
    // -----------------------------------------------------------------------

    async fetchEvents (queries: string[] = [], params: Dict = {}): Promise<any> {
        /**
         * Fetches events matching the given search terms and merges them into
         * this.events and this.markets. With no queries, fetches all active
         * events via loadMarkets().
         *
         *   await exchange.fetchEvents (['Trump', 'BTC', 'Fed'])
         *
         * Returns the full this.events dict (all cached events, not just the
         * newly fetched ones).
         *
         * Params:
         *   - limit (int) : max results per search term (default: 100)
         */

        const pageSize = this.safeInteger (params, 'limit', 50);
        const rest     = this.omit (params, [ 'limit' ]);

        // For each query: fetch page 1, then all remaining pages in parallel
        const seen: Dict = {};
        const rawEvents: any[] = [];
        for (const q of queries) {
            const baseRequest: Dict = { 'q': q, 'limit_per_type': pageSize, 'events_status': 'active' };
            const first = await this.gammaPublicGetPublicSearch (this.extend ({ 'page': 1 }, baseRequest, rest));
            const firstEvents = (this.safeList (first, 'events', []) || []) as any[];
            const pagination = this.safeValue (first, 'pagination', {});
            const totalResults = this.safeInteger (pagination, 'totalResults', firstEvents.length);
            const totalPages = Math.ceil (totalResults / pageSize);
            const remainingPages: number[] = [];
            for (let p = 2; p <= totalPages; p++) {
                remainingPages.push (p);
            }
            const restResponses = await Promise.all (remainingPages.map ((p) => this.gammaPublicGetPublicSearch (this.extend ({ 'page': p }, baseRequest, rest))));
            const allEvents = (firstEvents as any[]).concat (restResponses.flatMap ((r) => (this.safeList (r, 'events', []) || []) as any[]));
            for (const rawEvent of allEvents) {
                const eventId = this.safeString (rawEvent, 'id');
                if (eventId && !seen[eventId]) {
                    seen[eventId] = true;
                    rawEvents.push (rawEvent);
                }
            }
        }

        // Parse and merge into class-level caches
        if (!this.events) {
            this.events = {};
        }
        if (!this.markets) {
            this.markets = {};
        }

        for (const rawEvent of rawEvents) {
            const ccxtMarkets = this.parseEventToMarkets (rawEvent);
            for (const m of ccxtMarkets) {
                this.markets[m['symbol'] as string] = m;
            }
            const parsedEvent = this.parseEvent (rawEvent, ccxtMarkets);
            const eventSlug = this.safeString (rawEvent, 'slug');
            if (eventSlug) {
                const eventKey = this.shortenSlug (eventSlug as string);
                this.events[eventKey] = parsedEvent;
            }
        }

        return this.events;
    }

    parseEvent (rawEvent: Dict, marketsList: any[] = undefined): Dict {
        if (marketsList === undefined) {
            marketsList = this.parseEventToMarkets (rawEvent);
        }

        const slug = this.safeString (rawEvent, 'slug');
        return this.extend (rawEvent, {
            'id': this.safeString (rawEvent, 'id'),
            'slug': slug,
            'symbol': slug ? this.shortenSlug (slug) : undefined,
            'title': this.safeString (rawEvent, 'title'),
            'markets': marketsList,
            'info': rawEvent
        });
    }

    parseEvents (rawEvents: any[]): any[] {
        const result: any[] = [];
        for (const rawEvent of rawEvents) {
            result.push (this.parseEvent (rawEvent));
        }
        return result;
    }

    // -----------------------------------------------------------------------
    // Authentication signing
    // -----------------------------------------------------------------------

    sign (path: Str, api: any = 'gamma', method = 'GET', params: Dict = {}, headers: Dict = undefined, body: Dict = undefined) {
        // api is either a string ('gamma') or array (['gamma', 'public'])
        const apiGroup: string = typeof api === 'string' ? api : api[0];
        const access: string  = typeof api === 'string' ? 'public' : api[1];

        const baseUrls = this.urls['api'] as Dict;
        const baseUrl  = this.safeString (baseUrls, apiGroup, baseUrls['gamma'] as string);
        let url        = baseUrl + '/' + this.implodeParams (path as string, params);
        const query    = this.omit (params, this.extractParams (path as string));

        const querystring = this.urlencode (query);
        if (method === 'GET' && querystring) {
            url += '?' + querystring;
        }

        headers = this.extend ({
            'Accept':       'application/json',
            'Content-Type': 'application/json',
        }, headers || {});

        if (access === 'private') {
            this.checkRequiredCredentials ();
            const timestamp  = this.seconds ().toString ();
            const signature  = this.hmac (
                this.encode (timestamp + method + '/' + path),
                this.encode (this.secret),
                sha256,
                'base64'
            );

            headers = this.extend (headers, {
                'POLY_ADDRESS':    this.walletAddress,
                'POLY_API_KEY':    this.apiKey,
                'POLY_PASSPHRASE': this.password,
                'POLY_SIGNATURE':  signature,
                'POLY_TIMESTAMP':  timestamp,
            });

            if (method !== 'GET' && querystring) {
                body = query as any;
            }
        }

        return { 'url': url, 'method': method, 'body': body, 'headers': headers };
    }
}
