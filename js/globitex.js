'use strict';

//  ---------------------------------------------------------------------------

const { AuthenticationError } = require ('./base/errors');
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
            'has': {
                'cancelOrder': true,
                'CORS': true,
                'createMarketOrder': true,
                'cancelAllOrders': true,
                'createOrder': true,
                'fetchAccounts': true,
                'fetchBalance': true,
                'fetchMarkets': true,
                'fetchMyTrades': false, // 'emulated',
                'fetchOHLCV': false,
                'fetchOpenOrders': true,
                'fetchOrder': false,
                'fetchOrderBook': true,
                'fetchOrderBooks': false,
                'fetchClosedOrders': true,
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
                    'Missing signature': AuthenticationError,
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

    async fetchAccounts (params = {}) {
        await this.loadMarkets ();
        // Using this metod because globitex do not have a dedicated one to fetch accounts info
        const response = await this.privateGet1PaymentAccounts (params);
        // {
        //     "accounts": [
        //      {"account":"AFN561A01","main":true,"balance": [
        //        {"currency":"EUR","available":"100.0","reserved":"0.0"},
        //        {"currency":"BTC","available":"1.00000002","reserved":"0.0"}
        //     ]},
        //      {"account":"AFN561A02","main":false,"balance": [
        //        {"currency":"EUR","available":"120.0","reserved":"0.0"},
        //        {"currency":"BTC","available":"1.90000002","reserved":"0.0"}
        const data = this.safeValue (response, 'accounts', []);
        const result = [];
        for (let i = 0; i < data.length; i++) {
            const account = data[i];
            result.push ({
                'id': this.safeString (account, 'account'),
                'info': account,
            });
        }
        return result;
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
        // {
        //     "tradeId": 39,
        //     "symbol": "BTCEUR",
        //     "side": "sell",
        //     "originalOrderId": "114",
        //     "clientOrderId": "FTO18jd4ou41--25",
        //     "execQuantity": "10",
        //     "execPrice": "150",
        //     "timestamp": 1395231854030,
        //     "fee": "0.03",
        //     "isLiqProvided": false,
        //     "feeCurrency": "EUR",
        //     "account": "ADE922A21"
        //   },
        const timestamp = this.safeTimestamp2 (trade, 'timestamp');
        let symbol = undefined;
        if (market !== undefined) {
            symbol = market['symbol'];
        }
        const id = this.safeString2 (trade, 'tradeId');
        const originalOrderId = this.safeString (trade, 'originalOrderId');
        const type = undefined;
        const side = this.safeString (trade, 'side');
        const price = this.safeFloat (trade, 'execPrice');
        const amount = this.safeFloat2 (trade, 'execQuantity');
        const feeCurrency = this.safeString (trade, 'feeCurrency');
        const feeCost = this.safeString (trade, 'fee');
        let cost = undefined;
        if (price !== undefined) {
            if (amount !== undefined) {
                cost = price * amount;
            }
        }
        let fee = undefined;
        if (feeCost !== undefined) {
            fee = {
                'cost': feeCost,
                'currency': feeCurrency,
            };
        }
        return {
            'id': id,
            'info': trade,
            'timestamp': timestamp,
            'datetime': this.iso8601 (timestamp),
            'symbol': symbol,
            'order': originalOrderId, // verificar se este id estºa correto
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
        // {"trades": [
        //     {
        //       "tradeId": 39,
        //       "symbol": "BTCEUR",
        //       "side": "sell",
        //       "originalOrderId": "114",
        //       "clientOrderId": "FTO18jd4ou41--25",
        //       "execQuantity": "10",
        //       "execPrice": "150",
        //       "timestamp": 1395231854030,
        //       "fee": "0.03",
        //       "isLiqProvided": false,
        //       "feeCurrency": "EUR",
        //       "account": "ADE922A21"
        //     },
        await this.loadMarkets ();
        await this.loadAccounts ();
        let market = undefined;
        const request = {
            'by': 'ts',  // order by timestamp or client id: default timestamp
            'startIndex': 0, // starts on 0 by default
            'account': this.accounts[0], // check this as well
            'sort': 'desc', // desc or asc
            'from': '', // time stamp from
            'till': '', // timestamp till
        };
        if (limit !== undefined) {
            request['limit'] = 1000; // default 100
        }
        // can be multiple values comma separated, default is all
        if (symbol !== undefined) {
            market = this.market (symbol);
            request['symbols'] = market['id'];
        }
        const response = await this.privateGet2TradingOrdersActive (this.extend (request, params));
        const orders = this.safeValue (response, 'orders', []);
        return this.parseOrders (orders, market, since, limit);
    }

    async fetchBalance (params = {}) {
        // {
        //     "accounts": [
        //      {"account":"AFN561A01","main":true,"balance": [
        //        {"currency":"EUR","available":"100.0","reserved":"0.0"},
        //        {"currency":"BTC","available":"1.00000002","reserved":"0.0"}
        //     ]},
        await this.loadMarkets ();
        await this.loadAccounts ();
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
            account['used'] = reserved;
            result[code] = account;
        }
        return this.parseBalance (result);
    }

    async createOrder (symbol, type, side, amount, price = undefined, params = {}) {
        await this.loadMarkets ();
        await this.loadAccounts ();
        const market = this.market (symbol);
        const request = {
            'account': this.accounts[0]['id'], // protect this code later
            'type': type,
            'side': side,
            'symbol': market['id'], // symbol here check this, BTCEUR
            'quantity': this.amountToPrecision (symbol, amount),
        };
        // ExpireTime
        const expireTime = this.safeValue (params, 'expireTime');
        if (expireTime !== undefined) {
            request['expireTime'] = expireTime;
        } else {
            throw new InvalidOrder (this.id + ' createOrder method requires a expireTime or expireIn param for a ' + type + ' order, you can also set the expireIn exchange-wide option');
        }
        const clientOrderId = this.safeString2 (params, 'clientOrderId', 'client_oid');
        if (clientOrderId !== undefined) {
            request['clientOrderId'] = clientOrderId;
            params = this.omit (params, [ 'clientOrderId', 'client_oid' ]);
        }
        const stopPrice = this.safeFloat2 (params, 'stopPrice', 'stop_price');
        if (stopPrice !== undefined && (type === 'stop' || type === 'stopLimit')) {
            request['stopPrice'] = this.priceToPrecision (symbol, stopPrice);
            params = this.omit (params, [ 'stopPrice', 'stop_price' ]);
        }
        const timeInForce = this.safeString2 (params, 'timeInForce', 'time_in_force');
        if (timeInForce !== undefined) {
            request['timeInForce'] = timeInForce;
            params = this.omit (params, [ 'timeInForce', 'time_in_force' ]);
        }
        if (type === 'limit') {
            request['price'] = this.priceToPrecision (symbol, price);
            // request['size'] = this.amountToPrecision (symbol, amount);
        }
        if (type === 'market') {
            let cost = this.safeFloat2 (params, 'cost', 'funds');
            if (cost === undefined) {
                if (price !== undefined) {
                    cost = amount * price;
                }
            } else {
                params = this.omit (params, [ 'cost', 'funds' ]);
            }
            // if (cost !== undefined) {
            //     request['funds'] = this.costToPrecision (symbol, cost);
            // } else {
            //     request['size'] = this.amountToPrecision (symbol, amount);
            // }
        }
        const response = await this.privatePostTradingNewOrder (this.extend (request, params));
        return this.parseOrder (response, market);
    }

    async cancelOrder (id, symbol = undefined, params = {}) {
        if (symbol === undefined) {
            throw new ArgumentsRequired (this.id + ' cancelOrder () requires a symbol argument');
        }
        if (id === undefined) {
            throw new ArgumentsRequired (this.id + ' cancelOrder () requires a clientOrderId argument');
        }
        await this.loadMarkets ();
        await this.loadAccounts ();
        const market = this.market (symbol);
        const request = {
            'clientOrder_Id': id,
            'account': this.accounts[0]['id'], // check if main account is required
        };
        const response = await this.privatePost1TradingCancelOrder (this.extend (request, params));
        // Normal order structure if everything is sucessfully
        // OR IF IT FAILS
        // { "CancelReject": {
        //     "clientOrderId": "11111112",
        //     "cancelRequestClientOrderId": "011111112",
        //     "rejectReasonCode": "orderNotFound",
        //     "account": "VER564A02"
        //     }
        //   }
        const responseData = this.safeValue (response, 'ExecutionReport', {});
        if (responseData) {
            const order = this.safeValue (responseData, 'order', {});
            return this.parseOrder (order, market);
        }
        const errorResponse = this.safeValue (response, 'CancelReject');
        const reason = this.safeString (errorResponse, 'rejectReasonCode');
        // FAILED TO CANCEL
        throw new ArgumentsRequired ('Order with id' + id + ' Failed due to:' + reason);
    }

    async cancelAllOrders (symbol = undefined, params = {}) {
        await this.loadMarkets ();
        await this.loadAccounts ();
        const request = {
            'account': this.accounts[0]['id'], // check this
        };
        let market = undefined;
        if (symbol !== undefined) {
            market = this.market (symbol);
            request['symbols'] = market['symbol']; // the request will be more performant if you include it
        }
        // if (side !== undefined) {
        //     request['side'] = side;
        // }
        return await this.privatePost1TradingCancelOrders (this.extend (request, params));
    }

    parseOrder (order, market = undefined) {
        //     {
        //      "orderId": "1",
        //      "orderStatus": "partiallyFilled",
        //      "lastTimestamp": 1395659434845,
        //      "orderPrice": "800",
        //      "orderQuantity": "1.01",
        //      "avgPrice": "800",
        //      "quantityLeaves": "0.01", what is this?????
        //      "type": "limit",
        //      "timeInForce": "GTC",
        //      "cumQuantity": "1",
        //      "clientOrderId": "111111111111111111111111",
        //      "symbol": "BTCEUR",
        //      "side": "buy",
        //      "execQuantity": "0.2",
        //      "orderSource": "WEB",
        //      "account": "ADE922A21"
        //     },
        const id = this.safeString (order, 'orderId');
        const side = this.safeString (order, 'side');
        const status = this.safeString (order, 'orderStatus'); // this.parseOrderStatus (this.safeString (order, 'status'));
        const marketId = this.safeString (order, 'symbol');
        market = this.safeMarket (marketId, market);
        const timestamp = this.safeTimestamp (order, 'lastTimestamp');
        const clientOrderId = this.safeString (order, 'clientOrderId');
        const price = this.safeFloat (order, 'orderPrice'); // check price
        const average = this.safeFloat (order, 'avgPrice');
        const amount = this.safeFloat (order, 'quantity');
        const filled = this.safeFloat (order, 'execQuantity');
        const timeInForce = this.safeString (order, 'timeInForce');
        const remaining = amount - filled;
        const cost = filled * average;
        // const lastTradeTimestamp = this.safeTimestamp (order, 'updated_timestamp');
        // const rawTrades = this.safeValue (order, 'operations', []);
        // const trades = this.parseTrades (rawTrades, market, undefined, undefined, {
        //     'side': side,
        //     'order': id,
        // });
        return {
            'info': order,
            'id': id,
            'clientOrderId': clientOrderId,
            'timestamp': timestamp,
            'datetime': this.iso8601 (timestamp),
            'lastTradeTimestamp': undefined,
            'symbol': market['symbol'],
            'type': 'limit',
            'timeInForce': timeInForce,
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
            'trades': undefined,
        };
    }

    async fetchOrder (id, symbol = undefined, params = {}) {
        await this.loadMarkets ();
        await this.loadAccounts ();
        const clientOrderId = this.safeString2 (params, 'clientOrderId', 'client_oid');
        if (clientOrderId === undefined) {
            throw new ArgumentsRequired (this.id + ' fetchOrder () requires a client order if argument');
        }
        const request = {
            'clientOrderId': clientOrderId,
            'account': this.accounts[0]['id'], // verify if we want allways the main account later
        };
        params = this.omit (params, ['clientOrderId', 'client_oid']);
        const market = this.market (symbol);
        const response = await this.privateGetTradingOrder (this.extend (request, params));
        const responseData = this.safeValue (response, 'orders', []);
        const order = responseData[0]; // protect this value
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
        await this.loadMarkets ();
        await this.loadAccounts ();
        let market = undefined;
        const request = {
            'startIndex': 0, // starts on 0 by default
            'account': this.accounts[0], // check this as well
            'sort': 'desc', // desc or asc
            'isTrades': true, // default
        };
        if (limit !== undefined) {
            request['maxResults'] = 1000; // default 100
        }
        // can be multiple values comma separated, default is all
        if (symbol !== undefined) {
            market = this.market (symbol);
            request['symbols'] = market['id'];
        }
        const response = await this.privateGet1TradingOrdersRecent (this.extend (request, params));
        const orders = this.safeValue (response, 'orders', []);
        return this.parseOrders (orders, market, since, limit);
    }

    async fetchOpenOrders (symbol = undefined, since = undefined, limit = undefined, params = {}) {
        await this.loadMarkets ();
        await this.loadAccounts ();
        const request = {};
        let market = undefined;
        // can be multiple values comma separated, default is all
        if (symbol !== undefined) {
            market = this.market (symbol);
            request['symbols'] = market['id'];
        }
        const response = await this.privateGet2TradingOrdersActive (this.extend (request, params));
        const orders = this.safeValue (response, 'orders', []);
        return this.parseOrders (orders, market, since, limit);
    }

    async fetchClosedOrders (symbol = undefined, since = undefined, limit = undefined, params = {}) {
        const request = {
            'statuses': 'canceled,expired,suspended',
        };
        const orders = await this.fetchOrders (symbol, since, limit, this.extend (request, params));
        return this.filterBy (orders, 'status', 'closed');
    }

    async fetchMyTrades (symbol = undefined, since = undefined, limit = undefined, params = {}) {
        //     {
        //       "tradeId": 39,
        //       "symbol": "BTCEUR",
        //       "side": "sell",
        //       "originalOrderId": "114",
        //       "clientOrderId": "FTO18jd4ou41--25",
        //       "execQuantity": "10",
        //       "execPrice": "150",
        //       "timestamp": 1395231854030,
        //       "fee": "0.03",
        //       "isLiqProvided": false,
        //       "feeCurrency": "EUR",
        //       "account": "ADE922A21"
        //     },
        await this.loadMarkets ();
        await this.loadAccounts ();
        let market = undefined;
        const request = {
            'by': 'ts',  // order by timestamp or client id: default timestamp
            'startIndex': 0, // starts on 0 by default
            'account': this.accounts[0], // check this as well
            'sort': 'desc', // desc or asc
            'from': '', // time stamp from
            'till': '', // timestamp till
        };
        if (limit !== undefined) {
            request['limit'] = 1000; // default 100
        }
        // can be multiple values comma separated, default is all
        if (symbol !== undefined) {
            market = this.market (symbol);
            request['symbols'] = market['id'];
        }
        const response = await this.privateGet2TradingOrdersActive (this.extend (request, params));
        const orders = this.safeValue (response, 'orders', []);
        return this.parseTrades (orders, market, since, limit);
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
        const privateUrl = url.replace ('https://api.globitex.com', '') + uri; // hardcoded tmp
        let request = '';
        if (Object.keys (query).length) {
            request = '?' + this.urlencode (query);
        }
        if (method === 'GET') {
            url += uri;
            url += request;
        }
        if (api === 'private') {
            this.checkRequiredCredentials ();
            const nonce = this.nonce ();
            const message = this.apiKey + '&' + nonce + privateUrl + request;
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
