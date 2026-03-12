/// <reference lib="es2015" />
// ---------------------------------------------------------------------------
//
// Kalshi CCXT Exchange adapter
//
// Hierarchy:  Series → Events → Markets (binary YES/NO)
//
// Each binary Kalshi market produces TWO CCXT markets:
//   id:     {ticker}      symbol: {ticker}/YES:USD
//   id:     {ticker}-NO   symbol: {ticker}/NO:USD
//
// Prices are in US cents (0–99); CCXT exposes them as 0–1 decimals.
//
// ---------------------------------------------------------------------------

import Exchange from './abstract/kalshi.js';
import { rsa } from './base/functions/rsa.js';
import type {
    Int, Str, Num, Dict,
    Market, Ticker, Tickers, OrderBook, Trade, OHLCV,
    Order, Balances, Position,
} from './base/types.js';

// ---------------------------------------------------------------------------

/**
 * @class kalshi
 * @augments Exchange
 */
export default class kalshi extends Exchange {
    describe () {
        return this.deepExtend (super.describe (), {
            'id': 'kalshi',
            'name': 'Kalshi',
            'countries': [ 'US' ],
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
                'prediction': true,
                'fetchEvents': true,
                'fetchMarkets': true,
                'fetchTicker': true,
                'fetchTickers': false,
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
                'logo': 'https://kalshi.com/favicon.ico',
                'api': {
                    'kalshi': 'https://api.elections.kalshi.com/trade-api/v2',
                },
                'test': {
                    'kalshi': 'https://demo-api.kalshi.co/trade-api/v2',
                },
                'www': 'https://kalshi.com',
                'doc': [ 'https://trading-api.readme.io/reference/getting-started' ],
            },
            'api': {
                'kalshi': {
                    'public': {
                        'get': {
                            'events': 1,
                            'events/{event_ticker}': 1,
                            'series': 1,
                            'series/{series_ticker}': 1,
                            'markets': 1,
                            'markets/{ticker}': 1,
                            'markets/{ticker}/orderbook': 1,
                            'markets/{ticker}/trades': 1,
                            'series/{series_ticker}/markets/{ticker}/candlesticks': 1,
                        },
                    },
                    'private': {
                        'get': {
                            'portfolio/balance': 1,
                            'portfolio/orders': 1,
                            'portfolio/orders/{order_id}': 1,
                            'portfolio/positions': 1,
                            'portfolio/fills': 1,
                        },
                        'post': {
                            'portfolio/orders': 1,
                        },
                        'delete': {
                            'portfolio/orders/{order_id}': 1,
                            'portfolio/orders': 1,
                        },
                    },
                },
            },
            'requiredCredentials': {
                'apiKey': true,   // KALSHI-ACCESS-KEY (UUID)
                'privateKey': true,   // RSA PEM private key for signing
            },
            'fees': {
                'trading': {
                    'tierBased': false,
                    'percentage': true,
                    'maker': 0.0,
                    'taker': 0.07,  // 7% fee on profit
                },
            },
            'options': {
                'defaultFetchEventsLimit': 100,
                'maxFetchMarketsLimit': 1000,
                'defaultEventStatus': 'open',  // 'open' | 'closed' | 'settled'
            },
        });
    }

    // -----------------------------------------------------------------------
    // Markets — each binary Kalshi market → YES + NO CCXT markets
    // -----------------------------------------------------------------------

    async fetchMarkets (params: Dict = {}): Promise<Market[]> {
        const flatMarkets: Market[] = [];
        const eventsDict: Dict = {};
        let cursor: Str = undefined;
        const limit = this.safeInteger (this.options, 'maxFetchMarketsLimit', 1000);
        while (true) {
            const request: Dict = { 'limit': limit };
            if (cursor !== undefined) {
                request['cursor'] = cursor;
            }
            const response = await this.kalshiPublicGetMarkets (this.extend (request, params));
            const rawMarkets = (this.safeList (response, 'markets', []) || []) as any[];
            for (const raw of rawMarkets) {
                const parsed = this.parseBinaryMarketToOutcomes (raw);
                const eventTicker = this.safeString (raw, 'event_ticker');
                const eventKey = eventTicker ? this.shortenSlug (eventTicker) : undefined;
                for (const m of parsed) {
                    flatMarkets.push (m);
                    if (eventKey) {
                        if (!eventsDict[eventKey]) {
                            eventsDict[eventKey] = {
                                'id': eventTicker,
                                'slug': eventTicker,
                                'title': this.safeString (raw, 'title', eventTicker),
                                'markets': {},
                            };
                        }
                        (eventsDict[eventKey] as Dict)['markets'][m['symbol'] as string] = m;
                    }
                }
            }
            cursor = this.safeString (response, 'cursor');
            if (!cursor || rawMarkets.length < limit) {
                break;
            }
        }
        this.events = eventsDict;
        return flatMarkets;
    }

    parseBinaryMarketToOutcomes (raw: Dict): Market[] {
        const ticker = this.safeString (raw, 'ticker');
        const eventTicker = this.safeString (raw, 'event_ticker');
        const subtitle = this.safeString (raw, 'subtitle', this.safeString (raw, 'title'));
        const active = this.safeString (raw, 'status') === 'open';
        const endDate = this.safeString (raw, 'expiration_time');
        const volume = this.safeNumber (raw, 'volume');
        const liquidity = this.safeNumber (raw, 'liquidity');
        const openInt = this.safeNumber (raw, 'open_interest');
        // Derive series ticker: drop last hyphen-segment from event_ticker
        const eventParts = eventTicker ? eventTicker.split ('-') : [];
        const seriesTicker = eventParts.length > 1 ? eventParts.slice (0, -1).join ('-') : eventTicker;
        const outcomes = [
            { 'label': 'YES', 'id': ticker },
            { 'label': 'NO', 'id': ticker + '-NO' },
        ];
        const result: Market[] = [];
        for (const outcome of outcomes) {
            const symbol = this.slugToMarketId (eventTicker, ticker, outcome.label);
            result.push ({
                'id': outcome.id,
                'symbol': symbol,
                'base': outcome.label,
                'quote': 'USD',
                'settle': undefined,
                'baseId': outcome.id,
                'quoteId': 'USD',
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
                'taker': 0.07,
                'maker': 0.0,
                'percentage': true,
                'tierBased': false,
                'feeSide': 'get',
                'precision': {
                    'amount': 1,
                    'price': 0.01,
                },
                'limits': {
                    'leverage': { 'min': 1, 'max': 1 },
                    'amount': { 'min': 1, 'max': undefined },
                    'price': { 'min': 0.01, 'max': 0.99 },
                    'cost': { 'min': undefined, 'max': undefined },
                },
                'info': this.extend (raw, {
                    'ticker': ticker,
                    'eventTicker': eventTicker,
                    'seriesTicker': seriesTicker,
                    'subtitle': subtitle,
                    'outcomeLabel': outcome.label,
                    'volume': volume,
                    'liquidity': liquidity,
                    'openInterest': openInt,
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
        const market = this.market (symbol);
        const ticker = this.safeString (market['info'], 'ticker');
        const response = await this.kalshiPublicGetMarketsTicker (this.extend ({ 'ticker': ticker }, params));
        const raw = this.safeValue (response, 'market', response);
        return this.parseTicker (raw, market);
    }

    parseTicker (raw: Dict, market: Market = undefined): Ticker {
        const isNo = market ? (this.safeString (market['info'], 'outcomeLabel') === 'NO') : false;
        const now = this.milliseconds ();
        const symbol = this.safeSymbol (undefined, market);
        // Kalshi prices are in cents (integer 0–99) → divide by 100
        const yesAsk = this.safeNumber (raw, 'yes_ask');
        const yesBid = this.safeNumber (raw, 'yes_bid');
        const last = this.safeNumber (raw, 'last_price');
        const toDecimal = (v: Num) => (v !== undefined ? v / 100 : undefined);
        let bid: Num; let ask: Num; let
            close: Num;
        if (isNo) {
            bid = toDecimal (yesAsk !== undefined ? 100 - yesAsk : undefined);
            ask = toDecimal (yesBid !== undefined ? 100 - yesBid : undefined);
            close = toDecimal (last !== undefined ? 100 - last : undefined);
        } else {
            bid = toDecimal (yesBid);
            ask = toDecimal (yesAsk);
            close = toDecimal (last);
        }
        return this.safeTicker ({
            'symbol': symbol,
            'timestamp': now,
            'datetime': this.iso8601 (now),
            'high': undefined,
            'low': undefined,
            'bid': bid,
            'bidVolume': undefined,
            'ask': ask,
            'askVolume': undefined,
            'vwap': undefined,
            'open': undefined,
            'close': close,
            'last': close,
            'previousClose': undefined,
            'change': undefined,
            'percentage': undefined,
            'average': (bid !== undefined && ask !== undefined) ? (bid + ask) / 2 : undefined,
            'baseVolume': undefined,
            'quoteVolume': this.safeNumber (raw, 'volume'),
            'info': raw,
        }, market);
    }

    // -----------------------------------------------------------------------
    // Order book
    // -----------------------------------------------------------------------

    async fetchOrderBook (symbol: Str, limit: Int = undefined, params: Dict = {}): Promise<OrderBook> {
        await this.loadMarkets ();
        const market = this.market (symbol);
        const ticker = this.safeString (market['info'], 'ticker');
        const isNo = this.safeString (market['info'], 'outcomeLabel') === 'NO';
        const response = await this.kalshiPublicGetMarketsTickerOrderbook (this.extend ({
            'ticker': ticker,
        }, params));
        const book = this.safeValue (response, 'orderbook', response);
        const timestamp = this.milliseconds ();
        // Kalshi uses YES-side perspective: `yes` = bids, `no` = asks (inverted)
        const rawYes = (this.safeList (book, 'yes', []) || []) as any[];
        const rawNo = (this.safeList (book, 'no', []) || []) as any[];
        // Convert [price_cents, size] → {price, amount}
        const toLevel = (entry: any, invert: boolean) => {
            const priceCents = this.safeNumber (entry, 0);
            const size = this.safeNumber (entry, 1);
            const price = invert
                ? (100 - priceCents) / 100
                : priceCents / 100;
            return [ price, size ];
        };
        let bids: any[]; let
            asks: any[];
        if (isNo) {
            // NO perspective: NO bids come from rawNo, NO asks invert rawYes
            bids = rawNo.map ((e: any) => toLevel (e, false));
            asks = rawYes.map ((e: any) => toLevel (e, true));
        } else {
            // YES perspective: YES bids from rawYes, YES asks invert rawNo
            bids = rawYes.map ((e: any) => toLevel (e, false));
            asks = rawNo.map ((e: any) => toLevel (e, true));
        }
        return this.sortedOrders (symbol, timestamp, bids, asks);
    }

    sortedOrders (symbol: Str, timestamp: Int, bids: any[], asks: any[]): OrderBook {
        // Sort bids descending, asks ascending, match CCXT OrderBook shape
        bids.sort ((a: any, b: any) => b[0] - a[0]);
        asks.sort ((a: any, b: any) => a[0] - b[0]);
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
    // OHLCV
    // -----------------------------------------------------------------------

    async fetchOHLCV (symbol: Str, timeframe = '1m', since: Int = undefined, limit: Int = undefined, params: Dict = {}): Promise<OHLCV[]> {
        await this.loadMarkets ();
        const market = this.market (symbol);
        const ticker = this.safeString (market['info'], 'ticker');
        const seriesTicker = this.safeString (market['info'], 'seriesTicker', ticker);
        const periodMin = this.safeInteger (this.timeframes, timeframe, 1);
        const request: Dict = {
            'series_ticker': seriesTicker,
            'ticker': ticker,
            'period_interval': periodMin,
        };
        if (since !== undefined) {
            request['start_ts'] = this.parseToInt (since / 1000);
        }
        if (limit !== undefined && since !== undefined) {
            const tf = this.parseTimeframe (timeframe);
            const end = (since / 1000) + limit * tf;
            const now = this.seconds ();
            request['end_ts'] = end < now ? end : now;
        }
        const response = await this.kalshiPublicGetSeriesSeriesTickerMarketsTickerCandlesticks (
            this.extend (request, params)
        );
        const candles = (this.safeList (response, 'candlesticks', []) || []) as any[];
        return this.parseOHLCVs (candles, market, timeframe, since, limit);
    }

    parseOHLCV (ohlcv: Dict, market: Market = undefined): OHLCV {
        // Kalshi candlestick prices are in cents → divide by 100
        const ts = this.safeInteger (ohlcv, 'end_period_ts');
        const open = this.safeNumber (ohlcv, 'open');
        const high = this.safeNumber (ohlcv, 'high');
        const low = this.safeNumber (ohlcv, 'low');
        const close = this.safeNumber (ohlcv, 'close');
        const vol = this.safeNumber (ohlcv, 'volume');
        return [
            ts !== undefined ? ts * 1000 : undefined,
            open !== undefined ? open / 100 : undefined,
            high !== undefined ? high / 100 : undefined,
            low !== undefined ? low / 100 : undefined,
            close !== undefined ? close / 100 : undefined,
            vol,
        ];
    }

    // -----------------------------------------------------------------------
    // Trades
    // -----------------------------------------------------------------------

    async fetchTrades (symbol: Str, since: Int = undefined, limit: Int = undefined, params: Dict = {}): Promise<Trade[]> {
        await this.loadMarkets ();
        const market = this.market (symbol);
        const ticker = this.safeString (market['info'], 'ticker');
        const request: Dict = { 'ticker': ticker };
        if (limit !== undefined) {
            request['limit'] = limit;
        }
        const response = await this.kalshiPublicGetMarketsTickerTrades (this.extend (request, params));
        const trades = (this.safeList (response, 'trades', []) || []) as any[];
        return this.parseTrades (trades, market, since, limit);
    }

    parseTrade (trade: Dict, market: Market = undefined): Trade {
        const id = this.safeString (trade, 'trade_id');
        const ts = this.parse8601 (this.safeString (trade, 'created_time'));
        const priceCents = this.safeNumber (trade, 'yes_price');
        const price = priceCents !== undefined ? priceCents / 100 : undefined;
        const amount = this.safeNumber (trade, 'count');
        const rawSide = this.safeStringLower (trade, 'taker_side');
        const side = (rawSide === 'yes') ? 'buy' : (rawSide === 'no') ? 'sell' : undefined;
        return this.safeTrade ({
            'id': id,
            'info': trade,
            'timestamp': ts,
            'datetime': this.iso8601 (ts),
            'symbol': this.safeSymbol (undefined, market),
            'order': undefined,
            'type': undefined,
            'side': side,
            'takerOrMaker': 'taker',
            'price': price,
            'amount': amount,
            'cost': (price !== undefined && amount !== undefined) ? price * amount : undefined,
            'fee': undefined,
        }, market);
    }

    // -----------------------------------------------------------------------
    // Balance
    // -----------------------------------------------------------------------

    async fetchBalance (params: Dict = {}): Promise<Balances> {
        this.checkRequiredCredentials ();
        const response = await this.kalshiPrivateGetPortfolioBalance (params);
        return this.parseBalance (response);
    }

    parseBalance (response: Dict): Balances {
        // Kalshi balance in cents → divide by 100
        const result: Dict = { 'info': response };
        const balanceCents = this.safeNumber (response, 'balance');
        const total = balanceCents !== undefined ? balanceCents / 100 : undefined;
        result['USD'] = { 'free': total, 'used': 0, 'total': total };
        return result as Balances;
    }

    // -----------------------------------------------------------------------
    // Positions
    // -----------------------------------------------------------------------

    async fetchPositions (symbols?: Str[], params: Dict = {}): Promise<Position[]> {
        this.checkRequiredCredentials ();
        const response = await this.kalshiPrivateGetPortfolioPositions (params);
        const positions = (this.safeList (response, 'market_positions', []) || []) as any[];
        return this.parsePositions (positions, symbols);
    }

    parsePosition (position: Dict, market: Market = undefined): Position {
        const ticker = this.safeString (position, 'ticker');
        const mkt = this.safeMarket (ticker, market);
        const yesContracts = this.safeNumber (position, 'position');  // positive = long YES
        const fees = this.safeNumber (position, 'fees_paid');
        return {
            'id': undefined,
            'symbol': mkt['symbol'],
            'timestamp': undefined,
            'datetime': undefined,
            'contracts': yesContracts !== undefined ? (yesContracts < 0 ? -yesContracts : yesContracts) : undefined,
            'contractSize': 1,
            'side': yesContracts !== undefined ? (yesContracts >= 0 ? 'long' : 'short') : undefined,
            'notional': undefined,
            'leverage': 1,
            'unrealizedPnl': undefined,
            'realizedPnl': undefined,
            'collateral': undefined,
            'entryPrice': undefined,
            'markPrice': undefined,
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
    // Orders
    // -----------------------------------------------------------------------

    async fetchOpenOrders (symbol: Str = undefined, since: Int = undefined, limit: Int = undefined, params: Dict = {}): Promise<Order[]> {
        this.checkRequiredCredentials ();
        const request: Dict = { 'status': 'resting' };
        let market: Market = undefined;
        if (symbol !== undefined) {
            market = this.market (symbol);
            request['ticker'] = this.safeString (market['info'], 'ticker');
        }
        const response = await this.kalshiPrivateGetPortfolioOrders (this.extend (request, params));
        const orders = (this.safeList (response, 'orders', []) || []) as any[];
        return this.parseOrders (orders, market, since, limit);
    }

    async fetchOrder (id: Str, symbol: Str = undefined, params: Dict = {}): Promise<Order> {
        this.checkRequiredCredentials ();
        const response = await this.kalshiPrivateGetPortfolioOrdersOrderId (this.extend ({ 'order_id': id }, params));
        return this.parseOrder (this.safeValue (response, 'order', response));
    }

    parseOrder (order: Dict, market: Market = undefined): Order {
        const id = this.safeString (order, 'order_id');
        const ticker = this.safeString (order, 'ticker');
        const mkt = this.safeMarket (ticker, market);
        const status = this.parseOrderStatus (this.safeString (order, 'status'));
        const side = this.safeString (order, 'action') === 'buy' ? 'buy' : 'sell';
        const priceCents = this.safeNumber (order, 'no_price', this.safeNumber (order, 'yes_price'));
        const price = priceCents !== undefined ? priceCents / 100 : undefined;
        const amount = this.safeNumber (order, 'count');
        const filled = this.safeNumber (order, 'filled_count', 0);
        const remaining = (amount !== undefined && filled !== undefined) ? amount - filled : undefined;
        const ts = this.parse8601 (this.safeString (order, 'created_time'));
        return this.safeOrder ({
            'id': id,
            'clientOrderId': this.safeString (order, 'client_order_id'),
            'info': order,
            'timestamp': ts,
            'datetime': this.iso8601 (ts),
            'lastTradeTimestamp': undefined,
            'status': status,
            'symbol': mkt['symbol'],
            'type': this.safeStringLower (order, 'type', 'limit'),
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

    parseOrderStatus (status: Str): Str {
        const statuses: Dict = {
            'resting': 'open',
            'executed': 'closed',
            'canceled': 'canceled',
            'pending': 'open',
        };
        return this.safeString (statuses, status, status);
    }

    async createOrder (symbol: Str, type: Str, side: Str, amount: Num, price: Num = undefined, params: Dict = {}): Promise<Order> {
        this.checkRequiredCredentials ();
        await this.loadMarkets ();
        const market = this.market (symbol);
        const ticker = this.safeString (market['info'], 'ticker');
        const outcomeLabel = this.safeString (market['info'], 'outcomeLabel');
        const priceCents = price !== undefined ? this.parseToInt (price * 100 + 0.5) : undefined;
        const request: Dict = {
            'action': side === 'buy' ? 'buy' : 'sell',
            'count': amount,
            'side': outcomeLabel === 'NO' ? 'no' : 'yes',
            'ticker': ticker,
            'type': type,
        };
        if (priceCents !== undefined) {
            request[outcomeLabel === 'NO' ? 'no_price' : 'yes_price'] = priceCents;
        }
        const response = await this.kalshiPrivatePostPortfolioOrders (this.extend (request, params));
        return this.parseOrder (this.safeValue (response, 'order', response), market);
    }

    async cancelOrder (id: Str, symbol: Str = undefined, params: Dict = {}): Promise<Order> {
        this.checkRequiredCredentials ();
        const response = await this.kalshiPrivateDeletePortfolioOrdersOrderId (this.extend ({ 'order_id': id }, params));
        return this.parseOrder (this.safeValue (response, 'order', response));
    }

    async cancelAllOrders (symbol: Str = undefined, params: Dict = {}): Promise<Order[]> {
        this.checkRequiredCredentials ();
        const request: Dict = {};
        if (symbol !== undefined) {
            await this.loadMarkets ();
            const market = this.market (symbol);
            request['ticker'] = this.safeString (market['info'], 'ticker');
        }
        const response = await this.kalshiPrivateDeletePortfolioOrders (this.extend (request, params));
        return this.parseOrders (this.safeList (response, 'orders', []) as any[]);
    }

    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    async fetchEvents (queries: string[] = [], params: Dict = {}): Promise<any> {
        /**
         * Fetches events from the Kalshi /events endpoint, paginates up to
         * maxPages pages, filters client-side by query strings (Kalshi has no
         * search API), caches in this.events/this.markets, and returns the
         * matching events dict.
         *
         *   await exchange.fetchEvents (['Trump', 'KXBTC'])
         */
        const status = this.safeString (params, 'status', this.safeString (this.options, 'defaultEventStatus', 'open'));
        const pageLimit = this.safeInteger (params, 'limit', 200);
        const maxPages = this.safeInteger (params, 'maxPages', 5);
        const rest = this.omit (params, [ 'status', 'limit', 'maxPages' ]);
        if (!this.events) {
            this.events = {};
        }
        if (!this.markets) {
            this.markets = {};
        }
        const lowerQueries = (queries && queries.length > 0) ? queries.map ((q) => (q as string).toLowerCase ()) : [];
        const result: Dict = {};
        let cursor: string | undefined = undefined;
        let page = 0;
        while (page < maxPages) {
            const request: Dict = { 'status': status, 'limit': pageLimit, 'with_nested_markets': true };
            if (cursor) {
                request['cursor'] = cursor;
            }
            const response = await this.kalshiPublicGetEvents (this.extend (request, rest));
            const rawEvents = (this.safeList (response, 'events', []) || []) as any[];
            cursor = this.safeString (response, 'cursor');
            const filtered = lowerQueries.length === 0 ? rawEvents : rawEvents.filter ((rawEvent) => {
                const slug = (this.safeString (rawEvent, 'event_ticker') || '').toLowerCase ();
                const title = (this.safeString (rawEvent, 'title') || '').toLowerCase ();
                return lowerQueries.some ((q) => slug.indexOf (q) !== -1 || title.indexOf (q) !== -1);
            });
            filtered.forEach ((rawEvent) => {
                const parsedEvent = this.parseEvent (rawEvent);
                const eventTicker = this.safeString (rawEvent, 'event_ticker');
                const eventKey = eventTicker ? this.shortenSlug (eventTicker) : undefined;
                if (eventKey) {
                    (this.events as Dict)[eventKey] = parsedEvent;
                    result[eventKey] = parsedEvent;
                    Object.keys ((parsedEvent['markets'] || {}) as Dict).forEach ((sym) => {
                        this.markets[sym] = (parsedEvent['markets'] as Dict)[sym];
                    });
                }
            });
            page++;
            if (!cursor || rawEvents.length < pageLimit) {
                break;
            }
        }
        return result;
    }

    parseEvent (rawEvent: Dict): Dict {
        const rawMarkets = (this.safeList (rawEvent, 'markets', []) || []) as any[];
        const marketsDict: Dict = {};
        for (const rawMarket of rawMarkets) {
            const outcomes = this.parseBinaryMarketToOutcomes (rawMarket);
            for (const m of outcomes) {
                const sym = this.safeString (m, 'symbol');
                if (sym) {
                    marketsDict[sym] = m;
                }
            }
        }
        return this.extend (rawEvent, {
            'id': this.safeString (rawEvent, 'event_ticker'),
            'slug': this.safeString (rawEvent, 'event_ticker'),
            'title': this.safeString (rawEvent, 'title'),
            'markets': marketsDict,
        });
    }

    // -----------------------------------------------------------------------
    // RSA-PSS signing
    // -----------------------------------------------------------------------

    sign (path: Str, api: any = 'kalshi', method = 'GET', params: Dict = {}, headers: Dict = undefined, body: Dict = undefined) {
        const apiGroup: string = typeof api === 'string' ? api : api[0];
        const access: string = typeof api === 'string' ? 'public' : api[1];
        const baseUrls = this.urls['api'] as Dict;
        const baseUrl = this.safeString (baseUrls, apiGroup, baseUrls['kalshi'] as string);
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
            const timestamp = this.milliseconds ().toString ();
            // Signing payload: {timestamp}{METHOD}/{path_without_base}
            const pathForSigning = '/' + path;
            const payload = timestamp + method + pathForSigning;
            // RSA-PSS SHA-256 signature with the private key PEM
            const signature = rsa (payload, this.privateKey.replace (/\\n/g, '\n'), 'SHA256');
            headers = this.extend (headers, {
                'KALSHI-ACCESS-KEY': this.apiKey,
                'KALSHI-ACCESS-SIGNATURE': signature,
                'KALSHI-ACCESS-TIMESTAMP': timestamp,
            });
            if (method !== 'GET' && querystring) {
                body = query as any;
            }
        }
        return { 'url': url, 'method': method, 'body': body, 'headers': headers };
    }
}
