'use strict';

//  ---------------------------------------------------------------------------

const Exchange = require ('./base/Exchange');
const { ExchangeError, ArgumentsRequired, InvalidOrder } = require ('./base/errors');

//  ---------------------------------------------------------------------------

module.exports = class globitex extends Exchange {
    describe () {
        return this.deepExtend (super.describe (), {
            'id': 'globitex',
            'name': 'Globitex',
            'countries': ['fr', 'de', 'pt'], // Europe fill the remaining later
            'rateLimit': 1000,
            // 'version': 'v3',
            'has': {
                'cancelOrder': true,
                'CORS': true,
                'createMarketOrder': true,
                'createOrder': true,
                'fetchBalance': true,
                'fetchMarkets': true,
                'fetchMyTrades': 'emulated',
                'fetchOHLCV': false,
                'fetchOpenOrders': false,
                'fetchOrder': false,
                'fetchOrderBook': true,
                'fetchOrderBooks': false,
                'fetchOrders': false,
                'fetchTicker': true,
                'fetchTickers': true,
                'fetchTrades': false, // tmp testing
                'withdraw': true,
            },
            'urls': {
                'logo': 'https://user-images.githubusercontent.com/', // fill the image later
                'api': {
                    'public': 'https://api.globitex.com/api/1/public/',
                    'private': 'https://api.globitex.com/api/',
                },
                'www': 'https://www.globitex.com',
                'doc': [
                    'https://globitex.com/api/',
                ],
            },
            'api': {
                'public': {
                    'get': [
                        'time',
                        'symbols',
                        'ticker/{symbol}',
                        'ticker',
                        'orderbook/{symbol}',
                        'trades/{symbol}',
                        'trades/recent/{symbol}',
                    ],
                },
                'private': {
                    'get': [
                        '2/trading/active',
                        '1/trading/recent',
                        '1/trading/order',
                        '1/trading/trades',
                        '1/payment/accounts',
                        '1/payment/{payout}/fee/fiat',
                        '1/payment/fee/{crypto}',
                        '1/payment/deposit/fiat',
                        '1/payment/transations',
                        '1/gbx-utilization/list',
                        '1/payment/accounts',
                    ],
                    'post': [
                        '1/trading/new_order',
                        '2/trading/cancel_order',
                        '1/trading/cancel_orders',
                        '1/payment/internal',
                        '1/payment/payout/exchange',
                        '1/payment/payout/crypto',
                        '1/payment/payout/bank',
                        '1/payment/deposit/crypto/address',
                    ],
                },
            },
            'fees': {
                'trading': {
                    'percentage': true,
                    'tierBased': false,
                    'maker': 0.04 / 100,
                    'taker': 0.04 / 100,
                },
            },
            'requiredCredentials': {
                'apiKey': true,
                'secret': false,
            },
            'exceptions': {
                'broad': {
                },
                'exact': {
                },
            },
            'options': {
                'createMarketBuyOrderRequiresPrice': true,
            },
        });
    }

    async fetchTime (params = {}) {
        const response = await this.publicGetTime (params);
        // {
        //    "timestamp": 1612088909341
        // }
        return this.safeInteger (response, 'timestamp');
    }

    async fetchMarkets (params = {}) {
        let response = await this.publicGetSymbols (params);
        response = this.safeValue (response, 'symbols', []);
        // {
        //    "symbols": [
        //        {
        //            "symbol": "GBXETH",
        //             "priceIncrement": "0.0000001",
        //             "sizeIncrement": "0.001",
        //             "sizeMin": "5",
        //             "currency": "ETH",
        //             "commodity": "GBX"
        //         },
        //    ]
        // }
        const result = [];
        for (let i = 0; i < response.length; i++) {
            const market = response[i];
            const id = this.safeString (market, 'symbol');
            const baseId = this.safeString (market, 'commodity');
            const quoteId = this.safeString (market, 'currency');
            const base = this.safeCurrencyCode (baseId);
            const quote = this.safeCurrencyCode (quoteId);
            const symbol = base + '/' + quote;
            const sizeMin = this.safeFloat (market, 'sizeMin');
            const precision = this.safeFloat (market, 'sizeIncrement'); // Not sure if sizeIncrement or priceIncrement
            result.push ({
                'id': id,
                'info': market,
                'numericId': undefined,
                'symbol': symbol,
                'base': base,
                'quote': quote,
                'baseId': this.safeString (market, 'baseAsset'),
                'quoteId': this.safeString (market, 'quoteAsset'),
                'active': true,
                'precision': precision,
                'limits': {
                    'amount': {
                        'min': sizeMin,
                        'max': undefined,
                    },
                },
            });
        }
        return result;
    }

    async fetchCurrencies (params = {}) {
        let response = await this.publicGetAssets (params);
        response = this.safeValue (response, 'instruments', []);
        //
        // "instruments": [
        //     {
        //         "symbol": "GBXETH",
        //         "ask": "0.0000249",
        //         "bid": "0.0000105",
        //         "last": "0.0000000",
        //         "low": "0.0000000",
        //         "high": "0.0000000",
        //         "open": "0.0000110",
        //         "volume": "0.000",
        //         "volumeQuote": "0.0000000",
        //         "timestamp": 1612214672442
        //     },
        //
        const result = {};
        for (let i = 0; i < response.length; i++) {
            const currency = response[i];
            const id = this.safeString (currency, 'symbol');
            const code = this.safeCurrencyCode (id);
            // const name = this.safeString (currency, 'name');
            // const fee = this.safeFloat (currency, 'withdrawalFee');
            // const precision = this.safeFloat (currency, 'scale');
            const askPrice = this.safeFloat (currency, 'ask');
            const bidPrice = this.safeFloat (currency, 'bid');
            result[code] = {
                'id': id,
                'info': currency,
                'code': code,
                //  'name': name,
                'active': true,
                // 'fee': fee,
                // 'precision': precision,
                'limits': {
                    'amount': {
                        'min': undefined,
                        'max': undefined,
                    },
                    'price': {
                        'min': bidPrice,
                        'max': askPrice,
                    },
                    'cost': {
                        'min': undefined,
                        'max': undefined,
                    },
                    'withdraw': {
                        'min': undefined,
                        'max': undefined,
                    },
                },
            };
        }
        return result;
    }

    async fetchOrderBook (symbol, limit = undefined, params = {}) {
        // {
        //     "asks": [
        //         [
        //             "0.0000240", : size
        //             "177341.243" : value
        //         ],
        //         "bids":....
        await this.loadMarkets ();
        const market = this.market (symbol);
        const request = {
            'symbol': market['id'],
        };
        const response = await this.publicGetOrderbookSymbol (this.extend (request, params));
        const final = this.parseOrderBook (response, undefined, 'bids', 'asks');
        return final;
    }

    async fetchTickers (symbols = undefined, params = {}) {
        // [ {
        //     "symbol": "GBXETH",
        //     "ask": "0.0000249",
        //     "bid": "0.0000105",
        //     "last": "0.0000000",
        //     "low": "0.0000000",
        //     "high": "0.0000000",
        //     "open": "0.0000110",
        //     "volume": "0.000",
        //     "volumeQuote": "0.0000000",
        //     "timestamp": 1612216919341
        // }]
        await this.loadMarkets ();
        let response = await this.publicGetTicker (params);
        response = this.safeValue (response, 'instruments', []);
        const result = {};
        // const ids = Object.keys (response);
        for (let i = 0; i < response.length; i++) {
            const marketId = this.safeString (response[i], 'symbol');
            const market = this.safeMarket (marketId);
            const symbol = market['symbol'];
            result[symbol] = this.parseTicker (response[marketId], market);
        }
        return this.filterByArray (result, 'symbol', symbols);
    }

    async fetchTicker (symbol, params = {}) {
        // {
        //     "symbol": "GBXETH",
        //     "ask": "0.0000249",
        //     "bid": "0.0000105",
        //     "last": "0.0000000",
        //     "low": "0.0000000",
        //     "high": "0.0000000",
        //     "open": "0.0000110",
        //     "volume": "0.000",
        //     "volumeQuote": "0.0000000",
        //     "timestamp": 1612216919341
        // }
        await this.loadMarkets ();
        const market = this.market (symbol);
        const request = {
            'symbol': market['id'],
        };
        const response = await this.publicGetTickerSymbol (this.extend (request, params));
        return this.parseTicker (response, market);
    }

    parseTicker (ticker, market = undefined) {
        let symbol = undefined;
        if (market) {
            symbol = market['symbol'];
        }
        const timestamp = this.safeTimestamp (ticker, 'timestamp');
        const last = this.safeFloat (ticker, 'last');
        return {
            'symbol': symbol,
            'timestamp': timestamp,
            'datetime': this.iso8601 (timestamp),
            'high': this.safeFloat (ticker, 'high'),
            'low': this.safeFloat (ticker, 'low'),
            'bid': this.safeFloat (ticker, 'buy'),
            'bidVolume': undefined,
            'ask': this.safeFloat (ticker, 'ask'),
            'askVolume': undefined,
            'vwap': undefined,
            'open': this.safeFloat (ticker, 'open'),
            'close': last,
            'last': last,
            'previousClose': undefined,
            'change': undefined,
            'percentage': undefined,
            'average': undefined,
            'baseVolume': this.safeFloat (ticker, 'volume'),
            'quoteVolume': undefined,
            'info': ticker,
        };
    }

    parseTrade (trade, market = undefined) {
        const timestamp = this.safeTimestamp2 (trade, 'date', 'executed_timestamp');
        let symbol = undefined;
        if (market !== undefined) {
            symbol = market['symbol'];
        }
        const id = this.safeString2 (trade, 'tid', 'operation_id');
        const type = undefined;
        const side = this.safeString (trade, 'type');
        const price = this.safeFloat (trade, 'price');
        const amount = this.safeFloat2 (trade, 'amount', 'quantity');
        let cost = undefined;
        if (price !== undefined) {
            if (amount !== undefined) {
                cost = price * amount;
            }
        }
        const feeCost = this.safeFloat (trade, 'fee_rate');
        let fee = undefined;
        if (feeCost !== undefined) {
            fee = {
                'cost': feeCost,
                'currency': undefined,
            };
        }
        return {
            'id': id,
            'info': trade,
            'timestamp': timestamp,
            'datetime': this.iso8601 (timestamp),
            'symbol': symbol,
            'order': undefined,
            'type': type,
            'side': side,
            'takerOrMaker': undefined,
            'price': price,
            'amount': amount,
            'cost': cost,
            'fee': fee,
        };
    }

    async fetchTrades (symbol, since = undefined, limit = undefined, params = {}) {
        await this.loadMarkets ();
        // const market = this.market (symbol);
        // let method = 'publicGetCoinTrades';
        // const request = {
        //     'coin': market['base'],
        // };
        // if (since !== undefined) {
        //     method += 'From';
        //     request['from'] = parseInt (since / 1000);
        // }
        // const to = this.safeInteger (params, 'to');
        // if (to !== undefined) {
        //     method += 'To';
        // }
        // const response = await this[method] (this.extend (request, params));
        // return this.parseTrades (response, market, since, limit);
        return undefined;
    }

    async fetchBalance (params = {}) {
        // {
        //     "accounts": [
        //      {"account":"AFN561A01","main":true,"balance": [
        //        {"currency":"EUR","available":"100.0","reserved":"0.0"},
        //        {"currency":"BTC","available":"1.00000002","reserved":"0.0"}
        //     ]},
        await this.loadMarkets ();
        const response = await this.privateGet1PaymentAccounts (params);
        const data = this.safeValue (response, 'accounts', {});
        const mainAccount = data[0]; // Tmp main account
        const balances = this.safeValue (mainAccount, 'balance', {});
        const result = { 'info': response };
        for (let i = 0; i < balances.length; i++) {
            const balance = balances[i];
            const currencyId = this.safeString (balance, 'currency');
            const code = this.safeCurrencyCode (currencyId);
            const account = this.account ();
            const reserved = this.safeFloat (balance, 'reserved');
            const available = this.safeFloat (balance, 'available');
            account['total'] = reserved + available;
            account['free'] = available;
            result[code] = account;
        }
        return this.parseBalance (result);
    }

    async createOrder (symbol, type, side, amount, price = undefined, params = {}) {
        await this.loadMarkets ();
        const request = {
            'coin_pair': this.marketId (symbol),
        };
        let method = this.capitalize (side) + 'Order';
        if (type === 'limit') {
            method = 'privatePostPlace' + method;
            request['limit_price'] = this.priceToPrecision (symbol, price);
            request['quantity'] = this.amountToPrecision (symbol, amount);
        } else {
            method = 'privatePostPlaceMarket' + method;
            if (side === 'buy') {
                if (price === undefined) {
                    throw new InvalidOrder (this.id + ' createOrder() requires the price argument with market buy orders to calculate total order cost (amount to spend), where cost = amount * price. Supply a price argument to createOrder() call if you want the cost to be calculated for you from price and amount');
                }
                request['cost'] = this.priceToPrecision (symbol, amount * price);
            } else {
                request['quantity'] = this.amountToPrecision (symbol, amount);
            }
        }
        const response = await this[method] (this.extend (request, params));
        // TODO: replace this with a call to parseOrder for unification
        return {
            'info': response,
            'id': response['response_data']['order']['order_id'].toString (),
        };
    }

    async cancelOrder (id, symbol = undefined, params = {}) {
        if (symbol === undefined) {
            throw new ArgumentsRequired (this.id + ' cancelOrder () requires a symbol argument');
        }
        await this.loadMarkets ();
        const market = this.market (symbol);
        const request = {
            'coin_pair': market['id'],
            'order_id': id,
        };
        const response = await this.privatePostCancelOrder (this.extend (request, params));
        //
        //     {
        //         response_data: {
        //             order: {
        //                 order_id: 2176769,
        //                 coin_pair: 'BRLBCH',
        //                 order_type: 2,
        //                 status: 3,
        //                 has_fills: false,
        //                 quantity: '0.10000000',
        //                 limit_price: '1996.15999',
        //                 executed_quantity: '0.00000000',
        //                 executed_price_avg: '0.00000',
        //                 fee: '0.00000000',
        //                 created_timestamp: '1536956488',
        //                 updated_timestamp: '1536956499',
        //                 operations: []
        //             }
        //         },
        //         status_code: 100,
        //         server_unix_timestamp: '1536956499'
        //     }
        //
        const responseData = this.safeValue (response, 'response_data', {});
        const order = this.safeValue (responseData, 'order', {});
        return this.parseOrder (order, market);
    }

    parseOrderStatus (status) {
        const statuses = {
            '2': 'open',
            '3': 'canceled',
            '4': 'closed',
        };
        return this.safeString (statuses, status, status);
    }

    parseOrder (order, market = undefined) {
        //
        //     {
        //         "order_id": 4,
        //         "coin_pair": "BRLBTC",
        //         "order_type": 1,
        //         "status": 2,
        //         "has_fills": true,
        //         "quantity": "2.00000000",
        //         "limit_price": "900.00000",
        //         "executed_quantity": "1.00000000",
        //         "executed_price_avg": "900.00000",
        //         "fee": "0.00300000",
        //         "created_timestamp": "1453838494",
        //         "updated_timestamp": "1453838494",
        //         "operations": [
        //             {
        //                 "operation_id": 1,
        //                 "quantity": "1.00000000",
        //                 "price": "900.00000",
        //                 "fee_rate": "0.30",
        //                 "executed_timestamp": "1453838494",
        //             },
        //         ],
        //     }
        //
        const id = this.safeString (order, 'order_id');
        let side = undefined;
        if ('order_type' in order) {
            side = (order['order_type'] === 1) ? 'buy' : 'sell';
        }
        const status = this.parseOrderStatus (this.safeString (order, 'status'));
        const marketId = this.safeString (order, 'coin_pair');
        market = this.safeMarket (marketId, market);
        const timestamp = this.safeTimestamp (order, 'created_timestamp');
        const fee = {
            'cost': this.safeFloat (order, 'fee'),
            'currency': market['quote'],
        };
        const price = this.safeFloat (order, 'limit_price');
        // price = this.safeFloat (order, 'executed_price_avg', price);
        const average = this.safeFloat (order, 'executed_price_avg');
        const amount = this.safeFloat (order, 'quantity');
        const filled = this.safeFloat (order, 'executed_quantity');
        const remaining = amount - filled;
        const cost = filled * average;
        const lastTradeTimestamp = this.safeTimestamp (order, 'updated_timestamp');
        const rawTrades = this.safeValue (order, 'operations', []);
        const trades = this.parseTrades (rawTrades, market, undefined, undefined, {
            'side': side,
            'order': id,
        });
        return {
            'info': order,
            'id': id,
            'clientOrderId': undefined,
            'timestamp': timestamp,
            'datetime': this.iso8601 (timestamp),
            'lastTradeTimestamp': lastTradeTimestamp,
            'symbol': market['symbol'],
            'type': 'limit',
            'timeInForce': undefined,
            'postOnly': undefined,
            'side': side,
            'price': price,
            'stopPrice': undefined,
            'cost': cost,
            'average': average,
            'amount': amount,
            'filled': filled,
            'remaining': remaining,
            'status': status,
            'fee': fee,
            'trades': trades,
        };
    }

    async fetchOrder (id, symbol = undefined, params = {}) {
        if (symbol === undefined) {
            throw new ArgumentsRequired (this.id + ' fetchOrder () requires a symbol argument');
        }
        await this.loadMarkets ();
        const market = this.market (symbol);
        const request = {
            'coin_pair': market['id'],
            'order_id': parseInt (id),
        };
        const response = await this.privatePostGetOrder (this.extend (request, params));
        const responseData = this.safeValue (response, 'response_data', {});
        const order = this.safeValue (responseData, 'order');
        return this.parseOrder (order, market);
    }

    async withdraw (code, amount, address, tag = undefined, params = {}) {
        this.checkAddress (address);
        await this.loadMarkets ();
        const currency = this.currency (code);
        const request = {
            'coin': currency['id'],
            'quantity': amount.toFixed (10),
            'address': address,
        };
        if (code === 'BRL') {
            const account_ref = ('account_ref' in params);
            if (!account_ref) {
                throw new ArgumentsRequired (this.id + ' requires account_ref parameter to withdraw ' + code);
            }
        } else if (code !== 'LTC') {
            const tx_fee = ('tx_fee' in params);
            if (!tx_fee) {
                throw new ArgumentsRequired (this.id + ' requires tx_fee parameter to withdraw ' + code);
            }
            if (code === 'XRP') {
                if (tag === undefined) {
                    if (!('destination_tag' in params)) {
                        throw new ArgumentsRequired (this.id + ' requires a tag argument or destination_tag parameter to withdraw ' + code);
                    }
                } else {
                    request['destination_tag'] = tag;
                }
            }
        }
        const response = await this.privatePostWithdrawCoin (this.extend (request, params));
        return {
            'info': response,
            'id': response['response_data']['withdrawal']['id'],
        };
    }

    async fetchOrders (symbol = undefined, since = undefined, limit = undefined, params = {}) {
        if (symbol === undefined) {
            throw new ArgumentsRequired (this.id + ' fetchOrders () requires a symbol argument');
        }
        await this.loadMarkets ();
        const market = this.market (symbol);
        const request = {
            'coin_pair': market['id'],
        };
        const response = await this.privatePostListOrders (this.extend (request, params));
        const responseData = this.safeValue (response, 'response_data', {});
        const orders = this.safeValue (responseData, 'orders', []);
        return this.parseOrders (orders, market, since, limit);
    }

    async fetchOpenOrders (symbol = undefined, since = undefined, limit = undefined, params = {}) {
        if (symbol === undefined) {
            throw new ArgumentsRequired (this.id + ' fetchOpenOrders () requires a symbol argument');
        }
        await this.loadMarkets ();
        const market = this.market (symbol);
        const request = {
            'coin_pair': market['id'],
            'status_list': '[2]', // open only
        };
        const response = await this.privatePostListOrders (this.extend (request, params));
        const responseData = this.safeValue (response, 'response_data', {});
        const orders = this.safeValue (responseData, 'orders', []);
        return this.parseOrders (orders, market, since, limit);
    }

    async fetchMyTrades (symbol = undefined, since = undefined, limit = undefined, params = {}) {
        if (symbol === undefined) {
            throw new ArgumentsRequired (this.id + ' fetchMyTrades () requires a symbol argument');
        }
        await this.loadMarkets ();
        const market = this.market (symbol);
        const request = {
            'coin_pair': market['id'],
            'has_fills': true,
        };
        const response = await this.privatePostListOrders (this.extend (request, params));
        const responseData = this.safeValue (response, 'response_data', {});
        const ordersRaw = this.safeValue (responseData, 'orders', []);
        const orders = this.parseOrders (ordersRaw, market, since, limit);
        const trades = this.ordersToTrades (orders);
        return this.filterBySymbolSinceLimit (trades, symbol, since, limit);
    }

    ordersToTrades (orders) {
        const result = [];
        for (let i = 0; i < orders.length; i++) {
            const trades = this.safeValue (orders[i], 'trades', []);
            for (let y = 0; y < trades.length; y++) {
                result.push (trades[y]);
            }
        }
        return result;
    }

    sign (path, api = 'public', method = 'GET', params = {}, headers = undefined, body = undefined) {
        let url = this.urls['api'][api]; // + '/';
        const uri = this.implodeParams (path, params);
        const query = this.omit (params, this.extractParams (path));
        const privateUrl = url.replace ('https://api.globitex.com', '') + uri;
        if (false || api === 'public') {
            url += uri;
            if (Object.keys (query).length) {
                url += '?' + this.urlencode (query);
            }
        } else {
            this.checkRequiredCredentials ();
            const nonce = this.nonce ();
            body = this.urlencode (this.extend ({
                // 'tapi_method': path,
                // 'tapi_nonce': nonce,
            }, params));
            const message = this.apiKey + '&' + '?' + privateUrl;
            headers = {
                'Content-Type': 'application/x-www-form-urlencoded',
                'X-API-Key': this.apiKey,
                'X-Nonce': nonce,
                'X-Signature': this.hmac (this.encode (message), this.encode (this.secret), 'sha512'), // convert to hex and lower_case
            };
        }
        return { 'url': url, 'method': method, 'body': body, 'headers': headers };
    }

    async request (path, api = 'public', method = 'GET', params = {}, headers = undefined, body = undefined) {
        const response = await this.fetch2 (path, api, method, params, headers, body);
        if ('error_message' in response) {
            throw new ExchangeError (this.id + ' ' + this.json (response));
        }
        return response;
    }
};
