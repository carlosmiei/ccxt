'use strict';

// This file contains all methods part of the Exchange instance that do not have an
// exchange-specific implementation, thus can be transpiled to the other languages. Since they are part
// of the Exchange instance (at runtime), they can make use of the 'this' and access everything that is 
// defined in the Exchange class (options, methods, etc).

const { ArgumentsRequired, BadSymbol, NotSupported, NullResponse, InvalidOrder, ExchangeError } = require ('../errors');

module.exports = class ExchangeCommon {
    handleMarketTypeAndParams (methodName, market = undefined, params = {}) {
        const defaultType = this.safeString2 (this.options, 'defaultType', 'type', 'spot');
        const methodOptions = this.safeValue (this.options, methodName);
        let methodType = defaultType;
        if (methodOptions !== undefined) {
            if (typeof methodOptions === 'string') {
                methodType = methodOptions;
            } else {
                methodType = this.safeString2 (methodOptions, 'defaultType', 'type', methodType);
            }
        }
        const marketType = (market === undefined) ? methodType : market['type'];
        const type = this.safeString2 (params, 'defaultType', 'type', marketType);
        params = this.omit (params, [ 'defaultType', 'type' ]);
        return [ type, params ];
    }

    handleWithdrawTagAndParams (tag, params) {
        if (typeof tag === 'object') {
            params = this.extend (tag, params);
            tag = undefined;
        }
        if (tag === undefined) {
            tag = this.safeString (params, 'tag');
            if (tag !== undefined) {
                params = this.omit (params, 'tag');
            }
        }
        return [ tag, params ];
    }

    async editLimitBuyOrder (id, symbol, amount, price, params = {}) {
        return await this.editLimitOrder (id, symbol, 'buy', amount, price, params);
    }

    async editLimitSellOrder (id, symbol, amount, price, params = {}) {
        return await this.editLimitOrder (id, symbol, 'sell', amount, price, params);
    }

    async editLimitOrder (id, symbol, amount, price, params = {}) {
        return this.editOrder (id, symbol, 'limit', amount, price, params);
    }

    async editOrder (id, symbol, type, side, amount, price, params = {}) {
        if (!this.enableRateLimit) {
            throw new ExchangeError (this.id + ' editOrder() requires enableRateLimit = true');
        }
        await this.cancelOrder (id, symbol);
        return await this.createOrder (symbol, type, side, amount, price, params);
    }

    async createLimitOrder (symbol, side, amount, price, params = {}) {
        return await this.createOrder (symbol, 'limit', side, amount, price, params);
    }

    async createMarketOrder (symbol, side, amount, price = undefined, params = {}) {
        return await this.createOrder (symbol, 'market', side, amount, price, params);
    }

    async createLimitBuyOrder (symbol, amount, price, params = {}) {
        return await this.createOrder (symbol, 'limit', 'buy', amount, price, params);
    }

    async createLimitSellOrder (symbol, amount, price, params = {}) {
        return await this.createOrder (symbol, 'limit', 'sell', amount, price, params);
    }

    async createMarketBuyOrder (symbol, amount, params = {}) {
        return await this.createOrder (symbol, 'market', 'buy', amount, undefined, params);
    }

    async createMarketSellOrder (symbol, amount, params = {}) {
        return await this.createOrder (symbol, 'market', 'sell', amount, undefined, params);
    }

    async createPostOnlyOrder (symbol, type, side, amount, price, params = {}) {
        if (!this.has['createPostOnlyOrder']) {
            throw new NotSupported (this.id + 'createPostOnlyOrder() is not supported yet');
        }
        const query = this.extend (params, { 'postOnly': true });
        return await this.createOrder (symbol, type, side, amount, price, query);
    }

    async createReduceOnlyOrder (symbol, type, side, amount, price, params = {}) {
        if (!this.has['createReduceOnlyOrder']) {
            throw new NotSupported (this.id + 'createReduceOnlyOrder() is not supported yet');
        }
        const query = this.extend (params, { 'reduceOnly': true });
        return await this.createOrder (symbol, type, side, amount, price, query);
    }

    async createStopOrder (symbol, type, side, amount, price = undefined, stopPrice = undefined, params = {}) {
        if (!this.has['createStopOrder']) {
            throw new NotSupported (this.id + ' createStopOrder() is not supported yet');
        }
        if (stopPrice === undefined) {
            throw new ArgumentsRequired (this.id + ' create_stop_order() requires a stopPrice argument');
        }
        const query = this.extend (params, { 'stopPrice': stopPrice });
        return await this.createOrder (symbol, type, side, amount, price, query);
    }

    async createStopLimitOrder (symbol, side, amount, price, stopPrice, params = {}) {
        if (!this.has['createStopLimitOrder']) {
            throw new NotSupported (this.id + ' createStopLimitOrder() is not supported yet');
        }
        const query = this.extend (params, { 'stopPrice': stopPrice });
        return this.createOrder (symbol, 'limit', side, amount, price, query);
    }

    async createStopMarketOrder (symbol, side, amount, stopPrice, params = {}) {
        if (!this.has['createStopMarketOrder']) {
            throw new NotSupported (this.id + ' createStopMarketOrder() is not supported yet');
        }
        const query = this.extend (params, { 'stopPrice': stopPrice });
        return this.createOrder (symbol, 'market', side, amount, undefined, query);
    }

    async fetchFundingRate (symbol, params = {}) {
        if (this.has['fetchFundingRates']) {
            const market = await this.market (symbol);
            if (!market['contract']) {
                throw new BadSymbol (this.id + ' fetchFundingRate() supports contract markets only');
            }
            const rates = await this.fetchFundingRates ([ symbol ], params);
            const rate = this.safeValue (rates, symbol);
            if (rate === undefined) {
                throw new NullResponse (this.id + ' fetchFundingRate () returned no data for ' + symbol);
            } else {
                return rate;
            }
        } else {
            throw new NotSupported (this.id + ' fetchFundingRate () is not supported yet');
        }
    }

    async fetchMarkOHLCV (symbol, timeframe = '1m', since = undefined, limit = undefined, params = {}) {
        /**
         * @description fetches historical mark price candlestick data containing the open, high, low, and close price of a market
         * @param {str} symbol unified symbol of the market to fetch OHLCV data for
         * @param {str} timeframe the length of time each candle represents
         * @param {int|undefined} since timestamp in ms of the earliest candle to fetch
         * @param {int|undefined} limit the maximum amount of candles to fetch
         * @param {dict} params extra parameters specific to the exchange api endpoint
         * @returns {[[int|float]]} A list of candles ordered as timestamp, open, high, low, close, undefined
         */
        if (this.has['fetchMarkOHLCV']) {
            const request = {
                'price': 'mark',
            };
            return await this.fetchOHLCV (symbol, timeframe, since, limit, this.extend (request, params));
        } else {
            throw new NotSupported (this.id + ' fetchMarkOHLCV () is not supported yet');
        }
    }

    async fetchIndexOHLCV (symbol, timeframe = '1m', since = undefined, limit = undefined, params = {}) {
        /**
         * @description fetches historical index price candlestick data containing the open, high, low, and close price of a market
         * @param {str} symbol unified symbol of the market to fetch OHLCV data for
         * @param {str} timeframe the length of time each candle represents
         * @param {int|undefined} since timestamp in ms of the earliest candle to fetch
         * @param {int|undefined} limit the maximum amount of candles to fetch
         * @param {dict} params extra parameters specific to the exchange api endpoint
         * @returns {[[int|float]]} A list of candles ordered as timestamp, open, high, low, close, undefined
         */
        if (this.has['fetchIndexOHLCV']) {
            const request = {
                'price': 'index',
            };
            return await this.fetchOHLCV (symbol, timeframe, since, limit, this.extend (request, params));
        } else {
            throw new NotSupported (this.id + ' fetchIndexOHLCV () is not supported yet');
        }
    }

    async fetchPremiumIndexOHLCV (symbol, timeframe = '1m', since = undefined, limit = undefined, params = {}) {
        /**
         * @description fetches historical premium index price candlestick data containing the open, high, low, and close price of a market
         * @param {str} symbol unified symbol of the market to fetch OHLCV data for
         * @param {str} timeframe the length of time each candle represents
         * @param {int|undefined} since timestamp in ms of the earliest candle to fetch
         * @param {int|undefined} limit the maximum amount of candles to fetch
         * @param {dict} params extra parameters specific to the exchange api endpoint
         * @return {[[int|float]]} A list of candles ordered as timestamp, open, high, low, close, undefined
         */
        if (this.has['fetchPremiumIndexOHLCV']) {
            const request = {
                'price': 'premiumIndex',
            };
            return await this.fetchOHLCV (symbol, timeframe, since, limit, this.extend (request, params));
        } else {
            throw new NotSupported (this.id + ' fetchPremiumIndexOHLCV () is not supported yet');
        }
    }

    isPostOnly (type, timeInForce = undefined, exchangeSpecificOption = undefined, params = {}) {
        /**
         * @ignore
         * @method
         * @param {string} type Order type
         * @param {string} timeInForce
         * @param {boolean} exchangeSpecificOption True if the exchange specific post only setting is set
         * @param {dict} params Exchange specific params
         * @returns {boolean} true if a post only order, false otherwise
         */
        let postOnly = this.safeValue2 (params, 'postOnly', 'post_only', false);
        params = this.omit (params, [ 'post_only', 'postOnly' ]);
        const timeInForceUpper = (timeInForce !== undefined) ? timeInForce.toUpperCase () : undefined;
        const typeLower = type.toLowerCase ();
        const ioc = timeInForceUpper === 'IOC';
        const fok = timeInForceUpper === 'FOK';
        const timeInForcePostOnly = timeInForceUpper === 'PO';
        const isMarket = typeLower === 'market';
        postOnly = postOnly || (typeLower === 'postonly') || timeInForcePostOnly || exchangeSpecificOption;
        if (postOnly) {
            if (ioc || fok) {
                throw new InvalidOrder (this.id + ' postOnly orders cannot have timeInForce equal to ' + timeInForce);
            } else if (isMarket) {
                throw new InvalidOrder (this.id + ' postOnly orders cannot have type ' + type);
            } else {
                timeInForce = timeInForcePostOnly ? undefined : timeInForce;
                return [ 'limit', true, timeInForce, params ];
            }
        } else {
            return [ type, false, timeInForce, params ];
        }
    }

    async loadTimeDifference (params = {}) {
        const serverTime = await this.fetchTime (params);
        const after = this.milliseconds ();
        this.options['timeDifference'] = after - serverTime;
        return this.options['timeDifference'];
    }

    checkOrderArguments (market, type, side, amount, price, params) {
        if (price === undefined) {
            if (type === 'limit') {
                throw new ArgumentsRequired (this.id + ' createOrder() requires a price argument for a limit order');
            }
        }
        if (amount <= 0) {
            throw new ArgumentsRequired (this.id + ' createOrder() amount should be above 0');
        }
    }

    parseBorrowInterests (response, market = undefined) {
        const interest = [];
        for (let i = 0; i < response.length; i++) {
            const row = response[i];
            interest.push (this.parseBorrowInterest (row, market));
        }
        return interest;
    }

    parseFundingRateHistories (response, market = undefined, since = undefined, limit = undefined) {
        const rates = [];
        for (let i = 0; i < response.length; i++) {
            const entry = response[i];
            rates.push (this.parseFundingRateHistory (entry, market));
        }
        const sorted = this.sortBy (rates, 'timestamp');
        const symbol = (market === undefined) ? undefined : market['symbol'];
        return this.filterBySymbolSinceLimit (sorted, symbol, since, limit);
    }

    parseOpenInterests (response, market = undefined, since = undefined, limit = undefined) {
        const interests = [];
        for (let i = 0; i < response.length; i++) {
            const entry = response[i];
            const interest = this.parseOpenInterest (entry, market);
            interests.push (interest);
        }
        const sorted = this.sortBy (interests, 'timestamp');
        const symbol = this.safeString (market, 'symbol');
        return this.filterBySymbolSinceLimit (sorted, symbol, since, limit);
    }
}
