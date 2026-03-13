/// <reference lib="es2015" />
// ---------------------------------------------------------------------------
//
// Limitless CCXT Exchange adapter  (https://limitless.exchange)
//
// Hierarchy:  Group markets (events) → Child markets → YES/NO outcomes
//
// Each outcome token becomes one CCXT market:
//   id:     token slug + "/" + outcome label   (e.g. "market-slug/YES")
//   symbol: {slug}/{outcomeLabel}:USDC
//
// Sizes in the order book are in USDC micro-units (6 decimals) → ÷ 1_000_000.
//
// ---------------------------------------------------------------------------

import Exchange from './abstract/limitless.js';
import type {
    Int, Str, Num, Dict,
    Market, Ticker, OrderBook, OHLCV,
    Order, Position,
} from './base/types.js';

// ---------------------------------------------------------------------------

/**
 * @class limitless
 * @augments Exchange
 */
export default class Limitless extends Exchange {
    describe () {
        return this.deepExtend (super.describe (), {
            'id': 'limitless',
            'name': 'Limitless',
            'countries': [],
            'rateLimit': 200,
            'certified': false,
            'pro': false,
            'has': {
                'CORS': undefined,
                'spot': false,
                'margin': false,
                'swap': false,
                'future': false,
                'option': false,
                'prediction': true,
                'fetchEvents': true,
                'fetchMarkets': true,
                'fetchTicker': true,
                'fetchOrderBook': true,
                'fetchOHLCV': true,
                'fetchTrades': false,   // no public trades endpoint
                'fetchBalance': false,
                'fetchPositions': true,
                'fetchOpenOrders': true,
                'createOrder': true,
                'cancelOrder': true,
                'cancelAllOrders': true,
                'fetchCurrencies': false,
            },
            'timeframes': {
                '1m': 1,
                '5m': 5,
                '15m': 15,
                '1h': 60,
                '6h': 360,
                '1d': 1440,
            },
            'urls': {
                'logo': 'https://limitless.exchange/favicon.ico',
                'api': {
                    'limitless': 'https://api.limitless.exchange',
                },
                'www': 'https://limitless.exchange',
                'doc': [ 'https://docs.limitless.exchange' ],
            },
            'api': {
                'limitless': {
                    'public': {
                        'get': {
                            'markets/active': 1,
                            'markets/{addressOrSlug}': 1,
                            'markets/search': 1,
                            'markets/{slug}/orderbook': 1,
                            'markets/{slug}/historical-price': 1,
                            'auth/signing-message': 1,
                        },
                    },
                    'private': {
                        'get': {
                            'markets/{slug}/user-orders': 1,
                            'portfolio/positions': 1,
                            'portfolio/trades': 1,
                        },
                        'post': {
                            'auth/login': 1,
                            'orders': 1,
                            'orders/cancel-batch': 1,
                        },
                        'delete': {
                            'orders/{order_id}': 1,
                        },
                    },
                },
            },
            'requiredCredentials': {
                'apiKey': true,   // Limitless API key
                'privateKey': true,   // EVM private key for EIP-712 order signing
            },
            'fees': {
                'trading': {
                    'tierBased': false,
                    'percentage': true,
                    'maker': 0.02,
                    'taker': 0.02,
                },
            },
            'options': {
                'defaultFetchMarketsPages': 5,
                'marketsPageSize': 25,
                'usdcDecimals': 6,  // Limitless sizes are 6-decimal USDC
            },
        });
    }

    // -----------------------------------------------------------------------
    // Markets — group markets (events) + child markets → YES/NO outcomes
    // -----------------------------------------------------------------------

    /**
     * Fetches all active Limitless markets paginated and flattens each market into one CCXT market per outcome token.
     * @param params
     * @see https://docs.limitless.exchange/api-reference/markets/get-active-markets
     */
    async fetchMarkets (params: Dict = {}): Promise<Market[]> {
        const queries = this.safeList (params, 'queries', []) as string[];
        const rest = this.omit (params, [ 'queries' ]);
        if (queries && queries.length > 0) {
            const limit = this.safeInteger (rest, 'limit', 50);
            const searchRest = this.omit (rest, [ 'limit' ]);
            const seen: Dict = {};
            const rawMarkets: any[] = [];
            for (const q of queries) {
                const response = await this.limitlessPublicGetMarketsSearch (this.extend ({ 'term': q, 'limit': limit }, searchRest));
                const found = this.safeList (response, 'data', []) as any[];
                for (const raw of found) {
                    const slug = this.safeString (raw, 'slug');
                    if (slug && !seen[slug]) {
                        seen[slug] = true;
                        rawMarkets.push (raw);
                    }
                }
            }
            const flatMarkets: Market[] = [];
            const eventsDict: Dict = {};
            for (const raw of rawMarkets) {
                const groupId = this.safeString (raw, 'groupId', this.safeString (raw, 'slug'));
                const eventKey = groupId ? this.shortenSlug (groupId) : undefined;
                const parsed = this.parseMarketToOutcomes (raw);
                for (const m of parsed) {
                    flatMarkets.push (m);
                    if (eventKey) {
                        if (!eventsDict[eventKey]) {
                            eventsDict[eventKey] = { 'id': groupId, 'slug': groupId, 'title': this.safeString (raw, 'title', groupId), 'markets': {} };
                        }
                        (eventsDict[eventKey] as Dict)['markets'][m['symbol'] as string] = m;
                    }
                }
            }
            this.events = eventsDict;
            return flatMarkets;
        }
        const flatMarkets: Market[] = [];
        const eventsDict: Dict = {};
        let page = 1;
        const pageSize = this.safeInteger (this.options, 'marketsPageSize', 25);
        while (true) {
            const response = await this.limitlessPublicGetMarketsActive (this.extend ({
                'page': page,
                'limit': pageSize,
            }, rest));
            const rawMarkets = (this.safeList (response, 'data', response as any) || []) as any[];
            if (!rawMarkets || rawMarkets.length === 0) {
                break;
            }
            for (const raw of rawMarkets) {
                const groupId = this.safeString (raw, 'groupId', this.safeString (raw, 'slug'));
                const eventKey = groupId ? this.shortenSlug (groupId) : undefined;
                const parsed = this.parseMarketToOutcomes (raw);
                for (const m of parsed) {
                    flatMarkets.push (m);
                    if (eventKey) {
                        if (!eventsDict[eventKey]) {
                            eventsDict[eventKey] = {
                                'id': groupId,
                                'slug': groupId,
                                'title': this.safeString (raw, 'title', groupId),
                                'markets': {},
                            };
                        }
                        (eventsDict[eventKey] as Dict)['markets'][m['symbol'] as string] = m;
                    }
                }
            }
            if (rawMarkets.length < pageSize) {
                break;
            }
            page++;
        }
        this.events = eventsDict;
        return flatMarkets;
    }

    /**
     * Converts a single raw Limitless market into one CCXT market per YES/NO outcome token.
     * @param raw
     */
    parseMarketToOutcomes (raw: Dict): Market[] {
        const slug = this.safeString (raw, 'slug');
        const address = this.safeString (raw, 'address', slug);
        const groupId = this.safeString (raw, 'groupId', slug);
        const tokens = this.safeValue (raw, 'tokens', {});
        const active = this.safeBool (raw, 'active', true);
        const endDate = this.safeString (raw, 'deadline', this.safeString (raw, 'expiresAt'));
        const volume24h = this.safeNumber (raw, 'volume24h');
        const result: Market[] = [];
        // Tokens object contains YES/NO entries with token_id and label
        const tokenEntries = Object.keys (tokens);
        for (const outcomeLabel of tokenEntries) {
            const tokenData = tokens[outcomeLabel];
            const tokenId = this.safeString (tokenData, 'token_id', slug + '/' + outcomeLabel);
            const symbol = this.slugToMarketId (groupId, slug, outcomeLabel);
            result.push ({
                'id': tokenId,
                'symbol': symbol,
                'base': outcomeLabel,
                'quote': 'USDC',
                'settle': undefined,
                'baseId': tokenId,
                'quoteId': 'USDC',
                'settleId': undefined,
                'type': 'prediction',
                'spot': false,
                'margin': false,
                'swap': false,
                'future': false,
                'option': false,
                'prediction': true,
                'active': active,
                'contract': false,
                'linear': undefined,
                'inverse': undefined,
                'contractSize': undefined,
                'expiry': endDate ? this.parse8601 (endDate) : undefined,
                'expiryDatetime': endDate,
                'strike': undefined,
                'optionType': undefined,
                'taker': 0.02,
                'maker': 0.02,
                'percentage': true,
                'tierBased': false,
                'feeSide': 'get',
                'precision': {
                    'amount': 0.000001,
                    'price': 0.001,
                },
                'limits': {
                    'leverage': { 'min': 1, 'max': 1 },
                    'amount': { 'min': 0, 'max': undefined },
                    'price': { 'min': 0.001, 'max': 0.999 },
                    'cost': { 'min': undefined, 'max': undefined },
                },
                'info': this.extend (raw, {
                    'slug': slug,
                    'address': address,
                    'outcomeLabel': outcomeLabel,
                    'tokenId': tokenId,
                    'volume24h': volume24h,
                }),
                'created': undefined,
            } as unknown as Market);
        }
        return result;
    }

    // -----------------------------------------------------------------------
    // Ticker
    // -----------------------------------------------------------------------

    /**
     * Fetches the current price for a single Limitless outcome token from the market endpoint.
     * @param symbol
     * @param params
     * @see https://docs.limitless.exchange/api-reference/markets/get-market
     */
    async fetchTicker (symbol: Str, params: Dict = {}): Promise<Ticker> {
        await this.loadMarkets ();
        const market = this.market (symbol);
        const slug = this.safeString (market['info'], 'slug');
        const response = await this.limitlessPublicGetMarketsAddressOrSlug (this.extend ({
            'addressOrSlug': slug,
        }, params));
        return this.parseTicker (response, market);
    }

    /**
     * Parses a raw Limitless market object into a unified CCXT Ticker for the specified outcome token.
     * @param raw
     * @param market
     */
    parseTicker (raw: Dict, market: Market = undefined): Ticker {
        const outcomeLabel = market ? this.safeString (market['info'], 'outcomeLabel') : 'YES';
        const tokens = this.safeValue (raw, 'tokens', {});
        const tokenData = this.safeValue (tokens, outcomeLabel, {});
        const price = this.safeNumber (tokenData, 'price');
        const now = this.milliseconds ();
        return this.safeTicker ({
            'symbol': this.safeSymbol (undefined, market),
            'timestamp': now,
            'datetime': this.iso8601 (now),
            'high': undefined,
            'low': undefined,
            'bid': price,
            'bidVolume': undefined,
            'ask': price,
            'askVolume': undefined,
            'vwap': undefined,
            'open': undefined,
            'close': price,
            'last': price,
            'previousClose': undefined,
            'change': undefined,
            'percentage': this.safeNumber (tokenData, 'priceChange24h'),
            'average': price,
            'baseVolume': undefined,
            'quoteVolume': this.safeNumber (raw, 'volume24h'),
            'info': raw,
        }, market);
    }

    // -----------------------------------------------------------------------
    // Order book (sizes in 6-decimal USDC micro-units → ÷ 1_000_000)
    // -----------------------------------------------------------------------

    /**
     * Fetches the order book for a single Limitless outcome token, converting 6-decimal USDC sizes to whole units.
     * @param symbol
     * @param limit
     * @param params
     * @see https://docs.limitless.exchange/api-reference/markets/get-orderbook
     */
    async fetchOrderBook (symbol: Str, limit: Int = undefined, params: Dict = {}): Promise<OrderBook> {
        await this.loadMarkets ();
        const market = this.market (symbol);
        const slug = this.safeString (market['info'], 'slug');
        const response = await this.limitlessPublicGetMarketsSlugOrderbook (this.extend ({
            'slug': slug,
        }, params));
        const timestamp = this.milliseconds ();
        const decimals = this.safeInteger (this.options, 'usdcDecimals', 6);
        // scale = 10^decimals; USDC uses 6 decimals → 1_000_000
        const scale = 10 ** decimals;
        const rawBids = this.safeList (response, 'bids', []) as any[];
        const rawAsks = this.safeList (response, 'asks', []) as any[];
        const convertLevel = (entry: any) => {
            const price = this.safeNumber (entry, 'price');
            const sizeMicro = this.safeNumber (entry, 'size');
            return [ price, sizeMicro !== undefined ? sizeMicro / scale : undefined ];
        };
        const bids = rawBids.map (convertLevel);
        const asks = rawAsks.map (convertLevel);
        return {
            'symbol': symbol,
            'bids': bids,
            'asks': asks,
            'timestamp': timestamp,
            'datetime': this.iso8601 (timestamp),
            'nonce': undefined,
        } as unknown as OrderBook;
    }

    // -----------------------------------------------------------------------
    // OHLCV (single price point per tick — no true OHLCV)
    // -----------------------------------------------------------------------

    /**
     * Fetches historical price ticks for a single Limitless outcome token and maps them to OHLCV format.
     * @param symbol
     * @param timeframe
     * @param since
     * @param limit
     * @param params
     * @see https://docs.limitless.exchange/api-reference/markets/get-historical-price
     */
    async fetchOHLCV (symbol: Str, timeframe = '1d', since: Int = undefined, limit: Int = undefined, params: Dict = {}): Promise<OHLCV[]> {
        await this.loadMarkets ();
        const market = this.market (symbol);
        const slug = this.safeString (market['info'], 'slug');
        const fidelity = this.safeInteger (this.timeframes, timeframe, 1440);
        const response = await this.limitlessPublicGetMarketsSlugHistoricalPrice (this.extend ({
            'slug': slug,
            'fidelity': fidelity,
        }, params));
        const history = (this.safeList (response, 'data', response as any) || []) as any[];
        return this.parseOHLCVs (history, market, timeframe, since, limit);
    }

    /**
     * Parses a single Limitless price tick into a synthetic CCXT OHLCV tuple (all four OHLC fields set to price).
     * @param ohlcv
     * @param market
     */
    parseOHLCV (ohlcv: Dict, market: Market = undefined): OHLCV {
        const ts = this.safeInteger (ohlcv, 'timestamp');
        const price = this.safeNumber (ohlcv, 'price');
        return [
            ts !== undefined ? ts * 1000 : undefined,
            price, price, price, price,   // synthetic OHLC from single tick
            undefined,
        ];
    }

    // -----------------------------------------------------------------------
    // Orders
    // -----------------------------------------------------------------------

    /**
     * Fetches open orders for the authenticated Limitless user, optionally filtered by market slug.
     * @param symbol
     * @param since
     * @param limit
     * @param params
     * @see https://docs.limitless.exchange/api-reference/orders/get-user-orders
     */
    async fetchOpenOrders (symbol: Str = undefined, since: Int = undefined, limit: Int = undefined, params: Dict = {}): Promise<Order[]> {
        const request: Dict = {};
        let market: Market = undefined;
        if (symbol !== undefined) {
            market = this.market (symbol);
            request['slug'] = this.safeString (market['info'], 'slug');
        }
        const slug = this.safeString (request, 'slug', 'all');
        const response = await this.limitlessPrivateGetMarketsSlugUserOrders (
            this.extend ({ 'slug': slug }, this.omit (request, 'slug'), params)
        );
        const orders = this.safeList (response, 'data', []) as any[];
        return this.parseOrders (orders, market, since, limit);
    }

    /**
     * Parses a raw Limitless order object into a unified CCXT Order object.
     * @param order
     * @param market
     */
    parseOrder (order: Dict, market: Market = undefined): Order {
        const id = this.safeString (order, 'id', this.safeString (order, 'orderId'));
        const slug = this.safeString (order, 'marketSlug', this.safeString (order, 'slug'));
        const mkt = slug ? this.safeMarket (slug, market) : market;
        const status = this.parseOrderStatus (this.safeString (order, 'status'));
        const side = this.safeStringLower (order, 'side');
        const price = this.safeNumber (order, 'price');
        const amount = this.safeNumber (order, 'size', this.safeNumber (order, 'amount'));
        const filled = this.safeNumber (order, 'filledSize', 0);
        const remaining = (amount !== undefined && filled !== undefined) ? amount - filled : undefined;
        const ts = this.safeInteger (order, 'createdAt', this.parse8601 (this.safeString (order, 'created_at')));
        return this.safeOrder ({
            'id': id,
            'clientOrderId': undefined,
            'info': order,
            'timestamp': ts,
            'datetime': this.iso8601 (ts),
            'lastTradeTimestamp': undefined,
            'status': status,
            'symbol': mkt ? mkt['symbol'] : undefined,
            'type': 'limit',
            'timeInForce': 'GTC',
            'postOnly': undefined,
            'side': side,
            'price': price,
            'stopPrice': undefined,
            'triggerPrice': undefined,
            'average': undefined,
            'amount': amount,
            'cost': undefined,
            'filled': filled,
            'remaining': remaining,
            'fee': undefined,
            'trades': [],
        }, mkt);
    }

    /**
     * Maps a Limitless order status string to the CCXT unified status vocabulary.
     * @param status
     */
    parseOrderStatus (status: Str): Str {
        const statuses: Dict = {
            'open': 'open',
            'filled': 'closed',
            'cancelled': 'canceled',
            'canceled': 'canceled',
        };
        return this.safeString (statuses, status, status);
    }

    /**
     * Places a limit or market order on Limitless for the given outcome token.
     * @param symbol
     * @param type
     * @param side
     * @param amount
     * @param price
     * @param params
     * @see https://docs.limitless.exchange/api-reference/orders/create-order
     */
    async createOrder (symbol: Str, type: Str, side: Str, amount: Num, price: Num = undefined, params: Dict = {}): Promise<Order> {
        await this.loadMarkets ();
        const market = this.market (symbol);
        const slug = this.safeString (market['info'], 'slug');
        const outcome = this.safeString (market['info'], 'outcomeLabel');
        const request: Dict = {
            'marketSlug': slug,
            'outcome': outcome,
            'side': (side as string).toLowerCase (),
            'size': amount,
            'price': price,
            'orderType': type,
        };
        const response = await this.limitlessPrivatePostOrders (this.extend (request, params));
        return this.parseOrder (response, market);
    }

    /**
     * Cancels a single open order by ID on Limitless.
     * @param id
     * @param symbol
     * @param params
     * @see https://docs.limitless.exchange/api-reference/orders/cancel-order
     */
    async cancelOrder (id: Str, symbol: Str = undefined, params: Dict = {}): Promise<Order> {
        const response = await this.limitlessPrivateDeleteOrdersOrderId (this.extend ({ 'order_id': id }, params));
        return this.parseOrder (response);
    }

    /**
     * Cancels all open orders on Limitless, optionally scoped to one market slug.
     * @param symbol
     * @param params
     * @see https://docs.limitless.exchange/api-reference/orders/cancel-all-orders
     */
    async cancelAllOrders (symbol: Str = undefined, params: Dict = {}): Promise<Order[]> {
        const request: Dict = {};
        if (symbol !== undefined) {
            await this.loadMarkets ();
            const market = this.market (symbol);
            request['marketSlug'] = this.safeString (market['info'], 'slug');
        }
        const response = await this.limitlessPrivatePostOrdersCancelBatch (this.extend (request, params));
        return this.parseOrders (this.safeList (response, 'data', []) as any[]);
    }

    // -----------------------------------------------------------------------
    // Positions
    // -----------------------------------------------------------------------

    /**
     * Fetches open positions for the authenticated Limitless user from the portfolio endpoint.
     * @param symbols
     * @param params
     * @see https://docs.limitless.exchange/api-reference/portfolio/get-positions
     */
    async fetchPositions (symbols?: Str[], params: Dict = {}): Promise<Position[]> {
        const response = await this.limitlessPrivateGetPortfolioPositions (params);
        const positions = this.safeList (response, 'data', []) as any[];
        return this.parsePositions (positions, symbols);
    }

    /**
     * Parses a raw Limitless portfolio position into a unified CCXT Position object.
     * @param position
     * @param market
     */
    parsePosition (position: Dict, market: Market = undefined): Position {
        const slug = this.safeString (position, 'marketSlug', this.safeString (position, 'slug'));
        const outcome = this.safeString (position, 'outcome');
        const mkt = this.safeMarket (slug + '/' + outcome, market);
        const size = this.safeNumber (position, 'size');
        const price = this.safeNumber (position, 'avgPrice');
        const cur = this.safeNumber (position, 'currentPrice');
        return {
            'id': undefined,
            'symbol': mkt['symbol'],
            'timestamp': undefined,
            'datetime': undefined,
            'contracts': size,
            'contractSize': 1,
            'side': 'long',
            'notional': (size !== undefined && cur !== undefined) ? size * cur : undefined,
            'leverage': 1,
            'unrealizedPnl': (size !== undefined && price !== undefined && cur !== undefined) ? size * (cur - price) : undefined,
            'realizedPnl': this.safeNumber (position, 'realizedPnl'),
            'collateral': undefined,
            'entryPrice': price,
            'markPrice': cur,
            'liquidationPrice': undefined,
            'hedged': false,
            'maintenanceMargin': undefined,
            'maintenanceMarginPercentage': undefined,
            'initialMargin': undefined,
            'initialMarginPercentage': undefined,
            'marginRatio': undefined,
            'marginMode': 'cross',
            'marginType': 'cross',
            'percentage': undefined,
            'info': position,
        } as Position;
    }

    // -----------------------------------------------------------------------
    // Events (group markets act as events; child markets as CCXT markets)
    // -----------------------------------------------------------------------

    /**
     * Fetches Limitless markets matching the given search terms and merges them into this.events and this.markets.
     * With no queries, fetches all active markets via loadMarkets() and returns this.events.
     * @param queries
     * @param params
     * @see https://docs.limitless.exchange/api-reference/markets/search-markets
     */
    async fetchEvents (queries: string[] = [], params: Dict = {}): Promise<any> {
        if (!queries || queries.length === 0) {
            await this.loadMarkets ();
            return this.events;
        }
        const limit = this.safeInteger (params, 'limit', 50);
        const rest = this.omit (params, [ 'limit' ]);
        const seen: Dict = {};
        const rawMarkets: any[] = [];
        for (const q of queries) {
            const response = await this.limitlessPublicGetMarketsSearch (this.extend ({
                'term': q,
                'limit': limit,
            }, rest));
            const found = this.safeList (response, 'data', []) as any[];
            for (const raw of found) {
                const rawSlug = this.safeString (raw, 'slug');
                if (rawSlug && !seen[rawSlug]) {
                    seen[rawSlug] = true;
                    rawMarkets.push (raw);
                }
            }
        }
        if (!this.events) {
            this.events = {};
        }
        if (!this.markets) {
            this.markets = {};
        }
        for (const raw of rawMarkets) {
            const groupId = this.safeString (raw, 'groupId', this.safeString (raw, 'slug'));
            const eventKey = groupId ? this.shortenSlug (groupId) : undefined;
            const parsed = this.parseMarketToOutcomes (raw);
            for (const m of parsed) {
                const sym = m['symbol'] as string;
                this.markets[sym] = m;
                if (eventKey) {
                    if (!(this.events as Dict)[eventKey]) {
                        (this.events as Dict)[eventKey] = {
                            'id': groupId,
                            'slug': groupId,
                            'title': this.safeString (raw, 'title', groupId),
                            'markets': {},
                        };
                    }
                    ((this.events as Dict)[eventKey] as Dict)['markets'][sym] = m;
                }
            }
        }
        return this.events;
    }

    // -----------------------------------------------------------------------
    // Signing (API key header; EIP-712 signing handled externally for orders)
    // -----------------------------------------------------------------------

    /**
     * Builds the request URL and attaches the x-api-key header for private endpoints.
     * @param path
     * @param api
     * @param method
     * @param params
     * @param headers
     * @param body
     */
    sign (path: Str, api: any = 'limitless', method = 'GET', params: Dict = {}, headers: Dict = undefined, body: Dict = undefined) {
        const apiGroup: string = typeof api === 'string' ? api : api[0];
        const access: string = typeof api === 'string' ? 'public' : api[1];
        const baseUrls = this.urls['api'] as Dict;
        const baseUrl = this.safeString (baseUrls, apiGroup, baseUrls['limitless'] as string);
        let url = baseUrl + '/' + this.implodeParams (path as string, params);
        const query = this.omit (params, this.extractParams (path as string));
        const querystring = this.urlencode (query);
        if (method === 'GET' && querystring) {
            url += '?' + querystring;
        }
        headers = this.extend ({
            'Accept': 'application/json',
            'Content-Type': 'application/json',
        }, headers || {});
        if (access === 'private') {
            this.checkRequiredCredentials ();
            headers = this.extend (headers, {
                'x-api-key': this.apiKey,
            });
            if (method !== 'GET' && querystring) {
                body = query as any;
            }
        }
        return { 'url': url, 'method': method, 'body': body, 'headers': headers };
    }
}
