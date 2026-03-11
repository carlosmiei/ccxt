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
    Market, Ticker, OrderBook, Trade, OHLCV,
    Order, Balances, Position,
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
                '1m':   '24h',
                '5m':   '24h',
                '15m':  '7d',
                '1h':   '7d',
                '6h':   '30d',
                '1d':   '30d',
            },
            'urls': {
                'logo': 'https://myriad.markets/favicon.ico',
                'api': {
                    'myriad': 'https://api-v2.myriadprotocol.com',
                },
                'test': {
                    'myriad': 'https://api-v2.staging.myriadprotocol.com',
                },
                'www':  'https://myriad.markets',
                'doc':  ['https://docs.myriad.markets'],
            },
            'api': {
                'myriad': {
                    'public': {
                        'get': {
                            'questions':                 1,
                            'questions/{id}':            1,
                            'markets':                   1,
                            'markets/{networkId}/{id}':  1,
                            'markets/{id}/events':       1,
                        },
                    },
                    'private': {
                        'post': {
                            'markets/quote':             1,
                        },
                    },
                },
            },
            'requiredCredentials': {
                'apiKey': true,   // x-api-key header
            },
            'fees': {
                'trading': {
                    'tierBased':  false,
                    'percentage': true,
                    'maker':      0.02,
                    'taker':      0.02,
                },
            },
            'options': {
                'defaultFetchMarketsLimit':  50,
                'defaultFetchEventsLimit':   50,
                'defaultMarketStatus':       'open',   // 'open' | 'closed' | 'resolved'
                'networks': {
                    '2741':  'Abstract',
                    '59144': 'Linea',
                    '56':    'BNB Chain',
                },
            },
        });
    }

    // -----------------------------------------------------------------------
    // Markets — each market outcome → one CCXT market
    // -----------------------------------------------------------------------

    async fetchMarkets (params: Dict = {}): Promise<Market[]> {
        const markets: Market[] = [];
        let page = 1;
        const limit = this.safeInteger (this.options, 'defaultFetchMarketsLimit', 50);
        const status = this.safeString (params, 'status', this.safeString (this.options, 'defaultMarketStatus', 'open'));
        const rest   = this.omit (params, ['status']);

        while (true) {
            const response = await this.myriadPublicGetMarkets (this.extend ({
                'status': status,
                'limit':  limit,
                'page':   page,
            }, rest));

            const rawMarkets = (this.safeList (response, 'data', response as any) || []) as any[];
            if (!rawMarkets || rawMarkets.length === 0) {
                break;
            }

            for (const raw of rawMarkets) {
                const parsed = this.parseMarketOutcomes (raw);
                for (const m of parsed) {
                    markets.push (m);
                }
            }

            if (rawMarkets.length < limit) {
                break;
            }
            page++;
        }
        return markets;
    }

    parseMarketOutcomes (raw: Dict): Market[] {
        const networkId  = this.safeString (raw, 'networkId');
        const marketId   = this.safeString (raw, 'id');
        const slug       = this.safeString (raw, 'slug', marketId);
        const outcomes   = (this.safeList (raw, 'outcomes', []) || []) as any[];
        const endDate    = this.safeString (raw, 'expiresAt');
        const state      = this.safeString (raw, 'state', 'open');
        const active     = state === 'open';
        const volume24h  = this.safeNumber (raw, 'volume24h');
        const result: Market[] = [];

        for (const outcome of outcomes) {
            const outcomeId    = this.safeString (outcome, 'outcomeId');
            const outcomeLabel = this.safeString (outcome, 'label', outcomeId);
            const price        = this.safeNumber (outcome, 'price');

            // id: {networkId}:{marketId}/{outcomeId}
            const id     = networkId + ':' + marketId + '/' + outcomeId;
            // symbol: {networkId}:{marketId}/{outcomeLabel}:USDC
            const symbol = networkId + ':' + marketId + '/' + outcomeLabel + ':USDC';

            result.push ({
                'id':             id,
                'symbol':         symbol,
                'base':           outcomeLabel,
                'quote':          'USDC',
                'settle':         undefined,
                'baseId':         id,
                'quoteId':        'USDC',
                'settleId':       undefined,
                'type':           'prediction',
                'spot':           false,
                'margin':         false,
                'swap':           false,
                'future':         false,
                'option':         false,
                'prediction':     true,
                'active':         active,
                'contract':       false,
                'linear':         undefined,
                'inverse':        undefined,
                'contractSize':   undefined,
                'expiry':         endDate ? this.parse8601 (endDate) : undefined,
                'expiryDatetime': endDate,
                'strike':         undefined,
                'optionType':     undefined,
                'taker':          0.02,
                'maker':          0.02,
                'percentage':     true,
                'tierBased':      false,
                'feeSide':        'get',
                'precision': {
                    'amount': 0.01,
                    'price':  0.001,
                },
                'limits': {
                    'leverage': { 'min': 1,    'max': 1        },
                    'amount':   { 'min': 0,    'max': undefined },
                    'price':    { 'min': 0.001,'max': 0.999    },
                    'cost':     { 'min': undefined, 'max': undefined },
                },
                'info': this.extend (raw, {
                    'networkId':    networkId,
                    'marketId':     marketId,
                    'slug':         slug,
                    'outcomeId':    outcomeId,
                    'outcomeLabel': outcomeLabel,
                    'outcomePrice': price,
                    'volume24h':    volume24h,
                    'state':        state,
                }),
                'created': undefined,
            } as unknown as Market);
        }
        return result;
    }

    // -----------------------------------------------------------------------
    // Ticker
    // -----------------------------------------------------------------------

    async fetchTicker (symbol: Str, params: Dict = {}): Promise<Ticker> {
        await this.loadMarkets ();
        const market    = this.market (symbol);
        const networkId = this.safeString (market['info'], 'networkId');
        const marketId  = this.safeString (market['info'], 'marketId');

        const response = await this.myriadPublicGetMarketsNetworkIdId (this.extend ({
            'networkId': networkId,
            'id':        marketId,
        }, params));

        return this.parseTicker (response, market);
    }

    parseTicker (raw: Dict, market: Market = undefined): Ticker {
        const outcomeId  = market ? this.safeString (market['info'], 'outcomeId') : undefined;
        const outcomes   = (this.safeList (raw, 'outcomes', []) || []) as any[];
        let price: Num   = undefined;
        let change: Num  = undefined;

        for (const o of outcomes) {
            if (this.safeString (o, 'outcomeId') === outcomeId) {
                price  = this.safeNumber (o, 'price');
                change = this.safeNumber (o, 'priceChange24h');
                break;
            }
        }

        const now = this.milliseconds ();
        return this.safeTicker ({
            'symbol':        this.safeSymbol (undefined, market),
            'timestamp':     now,
            'datetime':      this.iso8601 (now),
            'high':          undefined,
            'low':           undefined,
            'bid':           price,
            'bidVolume':     undefined,
            'ask':           price,
            'askVolume':     undefined,
            'vwap':          undefined,
            'open':          undefined,
            'close':         price,
            'last':          price,
            'previousClose': undefined,
            'change':        change,
            'percentage':    change,
            'average':       price,
            'baseVolume':    undefined,
            'quoteVolume':   this.safeNumber (raw, 'volume24h'),
            'info':          raw,
        }, market);
    }

    // -----------------------------------------------------------------------
    // Order book (synthesized from AMM — single price point on each side)
    // -----------------------------------------------------------------------

    async fetchOrderBook (symbol: Str, limit: Int = undefined, params: Dict = {}): Promise<OrderBook> {
        await this.loadMarkets ();
        const market    = this.market (symbol);
        const networkId = this.safeString (market['info'], 'networkId');
        const marketId  = this.safeString (market['info'], 'marketId');
        const outcomeId = this.safeString (market['info'], 'outcomeId');

        const response = await this.myriadPublicGetMarketsNetworkIdId (this.extend ({
            'networkId': networkId,
            'id':        marketId,
        }, params));

        const outcomes  = (this.safeList (response, 'outcomes', []) || []) as any[];
        let price: Num  = undefined;
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
            'symbol':    symbol,
            'bids':      bid !== undefined ? [[bid, 9999]] : [],
            'asks':      ask !== undefined ? [[ask, 9999]] : [],
            'timestamp': timestamp,
            'datetime':  this.iso8601 (timestamp),
            'nonce':     undefined,
        } as unknown as OrderBook;
    }

    // -----------------------------------------------------------------------
    // OHLCV — from price_charts field on market object
    // -----------------------------------------------------------------------

    async fetchOHLCV (symbol: Str, timeframe = '1d', since: Int = undefined, limit: Int = undefined, params: Dict = {}): Promise<OHLCV[]> {
        await this.loadMarkets ();
        const market    = this.market (symbol);
        const networkId = this.safeString (market['info'], 'networkId');
        const marketId  = this.safeString (market['info'], 'marketId');
        const outcomeId = this.safeString (market['info'], 'outcomeId');
        const bucketKey = this.safeString (this.timeframes, timeframe, '30d');

        const response = await this.myriadPublicGetMarketsNetworkIdId (this.extend ({
            'networkId': networkId,
            'id':        marketId,
        }, params));

        const priceCharts = this.safeValue (response, 'price_charts', {});
        const bucket      = this.safeValue (priceCharts, bucketKey, {});
        // Each bucket may be keyed by outcomeId
        const points = (this.safeList (bucket, outcomeId, this.safeList (bucket, 'data', [])) || []) as any[];

        return this.parseOHLCVs (points, market, timeframe, since, limit);
    }

    parseOHLCV (ohlcv: Dict, market: Market = undefined): OHLCV {
        const ts    = this.safeInteger (ohlcv, 'timestamp');
        const open  = this.safeNumber  (ohlcv, 'open');
        const high  = this.safeNumber  (ohlcv, 'high');
        const low   = this.safeNumber  (ohlcv, 'low');
        const close = this.safeNumber  (ohlcv, 'close');
        const price = this.safeNumber  (ohlcv, 'price');  // fallback single-value tick
        return [
            ts !== undefined ? ts * 1000 : undefined,
            open  !== undefined ? open  : price,
            high  !== undefined ? high  : price,
            low   !== undefined ? low   : price,
            close !== undefined ? close : price,
            undefined,
        ];
    }

    // -----------------------------------------------------------------------
    // Events (questions)
    // -----------------------------------------------------------------------

    async fetchEvents (params: Dict = {}): Promise<any[]> {
        const id    = this.safeString (params, 'id');
        const query = this.safeString (params, 'query');
        const rest  = this.omit (params, ['id', 'query']);

        let rawEvents: any[] = [];

        if (id) {
            const response = await this.myriadPublicGetQuestionsId (this.extend ({ 'id': id }, rest));
            rawEvents = [response];
        } else {
            const limit = this.safeInteger (params, 'limit', this.safeInteger (this.options, 'defaultFetchEventsLimit', 50));
            const request: Dict = this.extend ({ 'limit': limit }, rest);
            if (query) {
                request['keyword'] = query;
            }
            const response = await this.myriadPublicGetQuestions (request);
            rawEvents = (this.safeList (response, 'data', response as any) || []) as any[];
        }

        return this.parseEvents (rawEvents);
    }

    parseEvent (rawEvent: Dict): Dict {
        const rawMarkets = (this.safeList (rawEvent, 'markets', []) || []) as any[];
        const marketsDict: Dict = {};

        for (const rawMarket of rawMarkets) {
            const outcomes = this.parseMarketOutcomes (rawMarket);
            for (const m of outcomes) {
                const sym = this.safeString (m, 'symbol');
                if (sym) {
                    marketsDict[sym] = m;
                }
            }
        }

        return this.extend (rawEvent, {
            'id':      this.safeString (rawEvent, 'id'),
            'slug':    this.safeString (rawEvent, 'slug'),
            'title':   this.safeString (rawEvent, 'title'),
            'markets': marketsDict,
        });
    }

    parseEvents (rawEvents: any[]): any[] {
        const result: any[] = [];
        for (const raw of rawEvents) {
            result.push (this.parseEvent (raw));
        }
        return result;
    }

    // -----------------------------------------------------------------------
    // Signing (x-api-key header only)
    // -----------------------------------------------------------------------

    sign (path: Str, api: any = 'myriad', method = 'GET', params: Dict = {}, headers: Dict = undefined, body: Dict = undefined) {
        const apiGroup: string = typeof api === 'string' ? api : api[0];
        const access: string  = typeof api === 'string' ? 'public' : api[1];

        const baseUrls = this.urls['api'] as Dict;
        const baseUrl  = this.safeString (baseUrls, apiGroup, baseUrls['myriad'] as string);
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
