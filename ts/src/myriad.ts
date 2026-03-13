/// <reference lib="es2015" />
// ---------------------------------------------------------------------------
//
// Myriad Protocol CCXT Exchange adapter  (https://myriad.markets)
//
// Hierarchy:  Questions (events) → Markets (multi-chain, multi-outcome)
//
// Each market outcome becomes one CCXT market:
//   id:     {networkId}:{marketId}/{outcomeId}
//   symbol: {networkId}:{marketId}/{outcomeLabel}:USDC
//
// Supports Abstract (2741), Linea (59144), BNB Chain (56).
//
// ---------------------------------------------------------------------------

import Exchange from './abstract/myriad.js';
import type {
    Int, Str, Num, Dict,
    Market, Ticker, OrderBook, OHLCV,
} from './base/types.js';

// ---------------------------------------------------------------------------

/**
 * @class myriad
 * @augments Exchange
 */
export default class Myriad extends Exchange {
    describe () {
        return this.deepExtend (super.describe (), {
            'id': 'myriad',
            'name': 'Myriad',
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
                'fetchTrades': false,
                'fetchBalance': false,
                'fetchPositions': false,
                'fetchOpenOrders': false,
                'createOrder': false,
                'cancelOrder': false,
                'fetchCurrencies': false,
            },
            'timeframes': {
                // Myriad maps timeframes to price_chart bucket keys
                '1m': '24h',
                '5m': '24h',
                '15m': '7d',
                '1h': '7d',
                '6h': '30d',
                '1d': '30d',
            },
            'urls': {
                'logo': 'https://myriad.markets/favicon.ico',
                'api': {
                    'myriad': 'https://api-v2.myriadprotocol.com',
                },
                'test': {
                    'myriad': 'https://api-v2.staging.myriadprotocol.com',
                },
                'www': 'https://myriad.markets',
                'doc': [ 'https://docs.myriad.markets' ],
            },
            'api': {
                'myriad': {
                    'public': {
                        'get': {
                            'questions': 1,
                            'questions/{id}': 1,
                            'markets': 1,
                            'markets/{networkId}/{id}': 1,
                            'markets/{id}/events': 1,
                        },
                    },
                    'private': {
                        'post': {
                            'markets/quote': 1,
                        },
                    },
                },
            },
            'requiredCredentials': {
                'apiKey': true,   // x-api-key header
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
                'defaultFetchMarketsLimit': 50,
                'defaultFetchEventsLimit': 50,
                'defaultMarketStatus': 'open',   // 'open' | 'closed' | 'resolved'
                'networks': {
                    '2741': 'Abstract',
                    '59144': 'Linea',
                    '56': 'BNB Chain',
                },
            },
        });
    }

    // -----------------------------------------------------------------------
    // Markets — each market outcome → one CCXT market
    // -----------------------------------------------------------------------

    /**
     * Fetches all Myriad markets paginated and flattens each multi-outcome market into one CCXT market per outcome.
     * @param params
     * @see https://docs.myriad.markets/api-reference/markets/list-markets
     */
    async fetchMarkets (params: Dict = {}): Promise<Market[]> {
        const queries = this.safeList (params, 'queries', []) as string[];
        const rest0 = this.omit (params, [ 'queries' ]);
        if (queries && queries.length > 0) {
            const limit = this.safeInteger (rest0, 'limit', this.safeInteger (this.options, 'defaultFetchMarketsLimit', 50));
            const searchRest = this.omit (rest0, [ 'limit' ]);
            const seen: Dict = {};
            const rawEvents: any[] = [];
            for (const q of queries) {
                const response = await this.myriadPublicGetQuestions (this.extend ({ 'keyword': q, 'limit': limit }, searchRest));
                const found = (this.safeList (response, 'data', response as any) || []) as any[];
                for (const rawEvent of found) {
                    const eventId = this.safeString (rawEvent, 'id');
                    if (eventId && !seen[eventId]) {
                        seen[eventId] = true;
                        rawEvents.push (rawEvent);
                    }
                }
            }
            const flatMarkets: Market[] = [];
            const eventsDict: Dict = {};
            for (const rawEvent of rawEvents) {
                const questionSlug = this.safeString (rawEvent, 'slug', this.safeString (rawEvent, 'id'));
                const eventKey = questionSlug ? this.shortenSlug (questionSlug) : undefined;
                const parsed = this.parseEvent (rawEvent);
                if (eventKey) {
                    eventsDict[eventKey] = parsed;
                }
                const rawMarkets = this.safeList (rawEvent, 'markets', []) as any[];
                for (const rawMarket of rawMarkets) {
                    const outcomes = this.parseMarketOutcomes (rawMarket, questionSlug);
                    for (const m of outcomes) {
                        flatMarkets.push (m);
                    }
                }
            }
            this.events = eventsDict;
            return flatMarkets;
        }
        const flatMarkets: Market[] = [];
        const eventsDict: Dict = {};
        let page = 1;
        const limit = this.safeInteger (this.options, 'defaultFetchMarketsLimit', 50);
        const status = this.safeString (rest0, 'status', this.safeString (this.options, 'defaultMarketStatus', 'open'));
        const rest = this.omit (rest0, [ 'status' ]);
        while (true) {
            const response = await this.myriadPublicGetMarkets (this.extend ({
                'status': status,
                'limit': limit,
                'page': page,
            }, rest));
            const rawMarkets = (this.safeList (response, 'data', response as any) || []) as any[];
            if (!rawMarkets || rawMarkets.length === 0) {
                break;
            }
            for (const raw of rawMarkets) {
                const networkId = this.safeString (raw, 'networkId');
                const eventKey = networkId ? this.shortenSlug (networkId) : undefined;
                const parsed = this.parseMarketOutcomes (raw);
                for (const m of parsed) {
                    flatMarkets.push (m);
                    if (eventKey) {
                        if (!eventsDict[eventKey]) {
                            eventsDict[eventKey] = {
                                'id': networkId,
                                'slug': networkId,
                                'title': (this.options as Dict)['networks'] ? ((this.options as Dict)['networks'] as Dict)[networkId] || networkId : networkId,
                                'markets': {},
                            };
                        }
                        (eventsDict[eventKey] as Dict)['markets'][m['symbol'] as string] = m;
                    }
                }
            }
            if (rawMarkets.length < limit) {
                break;
            }
            page++;
        }
        this.events = eventsDict;
        return flatMarkets;
    }

    /**
     * Converts a single raw Myriad market into one CCXT market per outcome entry.
     * @param raw
     * @param eventSlug
     */
    parseMarketOutcomes (raw: Dict, eventSlug: string = undefined): Market[] {
        const networkId = this.safeString (raw, 'networkId');
        const marketId = this.safeString (raw, 'id');
        const slug = this.safeString (raw, 'slug', marketId);
        const outcomes = this.safeList (raw, 'outcomes', []) as any[];
        const endDate = this.safeString (raw, 'expiresAt');
        const state = this.safeString (raw, 'state', 'open');
        const active = state === 'open';
        const volume24h = this.safeNumber (raw, 'volume24h');
        const result: Market[] = [];
        for (const outcome of outcomes) {
            const outcomeId = this.safeString (outcome, 'outcomeId');
            const outcomeLabel = this.safeString (outcome, 'label', outcomeId);
            const price = this.safeNumber (outcome, 'price');
            // id: {networkId}:{marketId}/{outcomeId}
            const id = networkId + ':' + marketId + '/' + outcomeId;
            // symbol: EVENT_SLUG:MARKET_SLUG:OUTCOME
            const symbol = this.slugToMarketId (eventSlug || networkId, slug, outcomeLabel);
            result.push ({
                'id': id,
                'symbol': symbol,
                'base': outcomeLabel,
                'quote': 'USDC',
                'settle': undefined,
                'baseId': id,
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
                    'amount': 0.01,
                    'price': 0.001,
                },
                'limits': {
                    'leverage': { 'min': 1, 'max': 1 },
                    'amount': { 'min': 0, 'max': undefined },
                    'price': { 'min': 0.001, 'max': 0.999 },
                    'cost': { 'min': undefined, 'max': undefined },
                },
                'info': this.extend (raw, {
                    'networkId': networkId,
                    'marketId': marketId,
                    'slug': slug,
                    'outcomeId': outcomeId,
                    'outcomeLabel': outcomeLabel,
                    'outcomePrice': price,
                    'volume24h': volume24h,
                    'state': state,
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
     * Fetches the current price for a single Myriad outcome by loading the parent market.
     * @param symbol
     * @param params
     * @see https://docs.myriad.markets/api-reference/markets/get-market
     */
    async fetchTicker (symbol: Str, params: Dict = {}): Promise<Ticker> {
        await this.loadMarkets ();
        const market = this.market (symbol);
        const networkId = this.safeString (market['info'], 'networkId');
        const marketId = this.safeString (market['info'], 'marketId');
        const response = await this.myriadPublicGetMarketsNetworkIdId (this.extend ({
            'networkId': networkId,
            'id': marketId,
        }, params));
        return this.parseTicker (response, market);
    }

    /**
     * Parses a raw Myriad market object into a unified CCXT Ticker for the specified outcome.
     * @param raw
     * @param market
     */
    parseTicker (raw: Dict, market: Market = undefined): Ticker {
        const outcomeId = market ? this.safeString (market['info'], 'outcomeId') : undefined;
        const outcomes = this.safeList (raw, 'outcomes', []) as any[];
        let price: Num = undefined;
        let change: Num = undefined;
        for (const o of outcomes) {
            if (this.safeString (o, 'outcomeId') === outcomeId) {
                price = this.safeNumber (o, 'price');
                change = this.safeNumber (o, 'priceChange24h');
                break;
            }
        }
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
            'change': change,
            'percentage': change,
            'average': price,
            'baseVolume': undefined,
            'quoteVolume': this.safeNumber (raw, 'volume24h'),
            'info': raw,
        }, market);
    }

    // -----------------------------------------------------------------------
    // Order book (synthesized from AMM — single price point on each side)
    // -----------------------------------------------------------------------

    /**
     * Fetches a synthesized AMM order book for a single Myriad outcome using the market price.
     * @param symbol
     * @param limit
     * @param params
     * @see https://docs.myriad.markets/api-reference/markets/get-market
     */
    async fetchOrderBook (symbol: Str, limit: Int = undefined, params: Dict = {}): Promise<OrderBook> {
        await this.loadMarkets ();
        const market = this.market (symbol);
        const networkId = this.safeString (market['info'], 'networkId');
        const marketId = this.safeString (market['info'], 'marketId');
        const outcomeId = this.safeString (market['info'], 'outcomeId');
        const response = await this.myriadPublicGetMarketsNetworkIdId (this.extend ({
            'networkId': networkId,
            'id': marketId,
        }, params));
        const outcomes = this.safeList (response, 'outcomes', []) as any[];
        let price: Num = undefined;
        for (const o of outcomes) {
            if (this.safeString (o, 'outcomeId') === outcomeId) {
                price = this.safeNumber (o, 'price');
                break;
            }
        }
        const timestamp = this.milliseconds ();
        // AMM: synthesize a single bid/ask pair at the current implied price
        const bid = price !== undefined ? price - 0.001 : undefined;
        const ask = price !== undefined ? price + 0.001 : undefined;
        return {
            'symbol': symbol,
            'bids': bid !== undefined ? [ [ bid, 9999 ] ] : [],
            'asks': ask !== undefined ? [ [ ask, 9999 ] ] : [],
            'timestamp': timestamp,
            'datetime': this.iso8601 (timestamp),
            'nonce': undefined,
        } as unknown as OrderBook;
    }

    // -----------------------------------------------------------------------
    // OHLCV — from price_charts field on market object
    // -----------------------------------------------------------------------

    /**
     * Fetches OHLCV data for a Myriad outcome from the price_charts bucket embedded in the market response.
     * @param symbol
     * @param timeframe
     * @param since
     * @param limit
     * @param params
     * @see https://docs.myriad.markets/api-reference/markets/get-market
     */
    async fetchOHLCV (symbol: Str, timeframe = '1d', since: Int = undefined, limit: Int = undefined, params: Dict = {}): Promise<OHLCV[]> {
        await this.loadMarkets ();
        const market = this.market (symbol);
        const networkId = this.safeString (market['info'], 'networkId');
        const marketId = this.safeString (market['info'], 'marketId');
        const outcomeId = this.safeString (market['info'], 'outcomeId');
        const bucketKey = this.safeString (this.timeframes, timeframe, '30d');
        const response = await this.myriadPublicGetMarketsNetworkIdId (this.extend ({
            'networkId': networkId,
            'id': marketId,
        }, params));
        const priceCharts = this.safeValue (response, 'price_charts', {});
        const bucket = this.safeValue (priceCharts, bucketKey, {});
        // Each bucket may be keyed by outcomeId
        const points = (this.safeList (bucket, outcomeId, this.safeList (bucket, 'data', [])) || []) as any[];
        return this.parseOHLCVs (points, market, timeframe, since, limit);
    }

    /**
     * Parses a single Myriad price chart data point into a CCXT OHLCV tuple.
     * @param ohlcv
     * @param market
     */
    parseOHLCV (ohlcv: Dict, market: Market = undefined): OHLCV {
        const ts = this.safeInteger (ohlcv, 'timestamp');
        const open = this.safeNumber (ohlcv, 'open');
        const high = this.safeNumber (ohlcv, 'high');
        const low = this.safeNumber (ohlcv, 'low');
        const close = this.safeNumber (ohlcv, 'close');
        const price = this.safeNumber (ohlcv, 'price');  // fallback single-value tick
        return [
            ts !== undefined ? ts * 1000 : undefined,
            open !== undefined ? open : price,
            high !== undefined ? high : price,
            low !== undefined ? low : price,
            close !== undefined ? close : price,
            undefined,
        ];
    }

    // -----------------------------------------------------------------------
    // Events (questions)
    // -----------------------------------------------------------------------

    /**
     * Fetches Myriad questions matching the given search terms and merges them into this.events and this.markets.
     * With no queries, fetches all questions via loadMarkets() and returns this.events.
     * @param queries
     * @param params
     * @see https://docs.myriad.markets/api-reference/questions/list-questions
     */
    async fetchEvents (queries: string[] = [], params: Dict = {}): Promise<any> {
        if (!queries || queries.length === 0) {
            await this.loadMarkets ();
            return this.events;
        }
        const limit = this.safeInteger (params, 'limit', this.safeInteger (this.options, 'defaultFetchEventsLimit', 50));
        const rest = this.omit (params, [ 'limit' ]);
        const seen: Dict = {};
        const rawEvents: any[] = [];
        for (const q of queries) {
            const response = await this.myriadPublicGetQuestions (this.extend ({
                'keyword': q,
                'limit': limit,
            }, rest));
            const found = (this.safeList (response, 'data', response as any) || []) as any[];
            for (const rawEvent of found) {
                const eventId = this.safeString (rawEvent, 'id');
                if (eventId && !seen[eventId]) {
                    seen[eventId] = true;
                    rawEvents.push (rawEvent);
                }
            }
        }
        if (!this.events) {
            this.events = {};
        }
        if (!this.markets) {
            this.markets = {};
        }
        for (const rawEvent of rawEvents) {
            const questionSlug = this.safeString (rawEvent, 'slug', this.safeString (rawEvent, 'id'));
            const eventKey = questionSlug ? this.shortenSlug (questionSlug) : undefined;
            const parsedEvent = this.parseEvent (rawEvent);
            if (eventKey) {
                (this.events as Dict)[eventKey] = parsedEvent;
                for (const sym of Object.keys ((parsedEvent['markets'] || {}) as Dict)) {
                    this.markets[sym] = (parsedEvent['markets'] as Dict)[sym];
                }
            }
        }
        return this.events;
    }

    /**
     * Parses a raw Myriad question object into the unified CCXT event shape with a nested markets dict.
     * @param rawEvent
     */
    parseEvent (rawEvent: Dict): Dict {
        const questionSlug = this.safeString (rawEvent, 'slug', this.safeString (rawEvent, 'id'));
        const rawMarkets = this.safeList (rawEvent, 'markets', []) as any[];
        const marketsDict: Dict = {};
        for (const rawMarket of rawMarkets) {
            const outcomes = this.parseMarketOutcomes (rawMarket, questionSlug);
            for (const m of outcomes) {
                const sym = this.safeString (m, 'symbol');
                if (sym) {
                    marketsDict[sym] = m;
                }
            }
        }
        return this.extend (rawEvent, {
            'id': this.safeString (rawEvent, 'id'),
            'slug': questionSlug,
            'title': this.safeString (rawEvent, 'title'),
            'markets': marketsDict,
        });
    }

    // -----------------------------------------------------------------------
    // Signing (x-api-key header only)
    // -----------------------------------------------------------------------

    /**
     * Builds the request URL and attaches the x-api-key header for private or authenticated endpoints.
     * @param path
     * @param api
     * @param method
     * @param params
     * @param headers
     * @param body
     */
    sign (path: Str, api: any = 'myriad', method = 'GET', params: Dict = {}, headers: Dict = undefined, body: Dict = undefined) {
        const apiGroup: string = typeof api === 'string' ? api : api[0];
        const access: string = typeof api === 'string' ? 'public' : api[1];
        const baseUrls = this.urls['api'] as Dict;
        const baseUrl = this.safeString (baseUrls, apiGroup, baseUrls['myriad'] as string);
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
        if (access === 'private' || this.apiKey) {
            if (this.apiKey) {
                headers = this.extend (headers, { 'x-api-key': this.apiKey });
            }
            if (method !== 'GET' && querystring) {
                body = query as any;
            }
        }
        return { 'url': url, 'method': method, 'body': body, 'headers': headers };
    }
}
