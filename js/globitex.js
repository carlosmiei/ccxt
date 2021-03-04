'use strict';

//  ---------------------------------------------------------------------------

const Exchange = require ('./base/Exchange');
const { ExchangeError, ArgumentsRequired, InvalidOrder, BadRequest, PermissionDenied, OrderNotFound } = require ('./base/errors');

//  ---------------------------------------------------------------------------

module.exports = class globitex extends Exchange {
    describe () {
        return this.deepExtend (super.describe (), {
            'id': 'globitex',
            'name': 'Globitex',
            'countries': ['fr', 'de', 'pt'], // Europe fill the remaining later
            'has': {
                'cancelOrder': false, // partial rested: request is well formed and mocked response
                'CORS': false,
                'createMarketOrder': false, // not supported
                'cancelAllOrders': true, // partial rested: request is well formed and mocked response
                'createOrder': true, // partial rested: request is well formed and mocked response
                'fetchAccounts': 'emulated', // tested
                'fetchBalance': true, // tested
                'fetchMarkets': true, // tested
                'fetchMyTrades': true, // partial tested: (request is well formed and mocked the response
                'fetchOHLCV': false, // not Supported
                'fetchOpenOrders': true, // partial tested: (request is well formed and mocked the response
                'fetchOrder': true, // partial tested: (request is well formed and mocked the response
                'fetchOrderBook': true, // tested
                'fetchOrderBooks': false, // not possible
                'fetchClosedOrders': 'emulated', // partial tested: (request is well formed and mocked the response
                'fetchFundingFees': true, // If true fails the text bc the test don't pass amount-> partial tested request is well formed but No permissions
                'fetchTradingFees': false, // notSupported
                'fetchOrders': true, // partial tested: (request is well formed and mocked the response
                'fetchTicker': true, // tested
                'fetchTickers': true, // tested
                'fetchTrades': true, // tested
                'fetchTime': true, // tested
                'withdraw': true, // If true fails the text bc the test don't pass amount -> partial tested: (request is well formed and mocked the response
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
                        '2/trading/orders/active',
                        '1/trading/recent',
                        '1/trading/orders/recent',
                        '1/trading/order',
                        '1/trading/trades',
                        '1/payment/accounts',
                        '1/payment/{payout}/fee/fiat',
                        '1/payment/fee/{crypto}',
                        '1/payment/deposit/fiat',
                        '1/payment/transations',
                        '1/gbx-utilization/list',
                        '1/payment/accounts',
                        '1/payment/payout/fee/crypto',
                        '1/payment/payout/fee/fiat',
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
                    'percentage': false,
                },
            },
            'requiredCredentials': {
                'apiKey': true,
                'secret': true,
            },
            'httpExceptions': {
                '400': BadRequest,
                '403': PermissionDenied,
                '404': OrderNotFound,
                '500': ExchangeError,
            },
            'errorMessages': {
                'Missing signature': 'Missing API key',
                '20': 'Missing nonce',
                '30': 'Missing signature',
                '40': 'Invalid API key',
                '50': 'Nonce is not monotonous',
                '60': 'Nonce is not valid',
                '70': 'Wrong signature',
                '80': 'No permissions',
                '90': 'API key is not enabled',
                '100': 'API key locked',
                '110': 'Invalid client state',
                '120': 'Invalid API key state',
                '130': 'Trading suspended',
                '140': 'REST API suspended',
                '200': 'Mandatory parameter missing',
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

    async fetchFundingFees (codes = undefined, params = {}) {
        await this.loadMarkets ();
        const withdrawFees = {};
        const info = {};
        if (codes === undefined) {
            codes = Object.keys (this.currencies);
        }
        const amount = this.safeValue (params, 'amount');
        if (!amount) {
            throw new ArgumentsRequired (this.id + ' requires amount parameter to fetchFundingFees');
        }
        for (let i = 0; i < codes.length; i++) {
            const code = codes[i];
            const currency = this.currency (code);
            const request = {
                'currency': currency['id'],
                'amount': amount.toString (),
                'account': await this.getAccountId (params),
            };
            let withdrawResponse = {};
            if (this.isFiatSymbol (code)) {
                withdrawResponse = await this.privateGet1PaymentPayoutFeeFiat (request);
                withdrawFees[code] = {
                    'unknown': this.safeValue (withdrawResponse, 'unknown'),
                    'currency': this.safeSymbol (withdrawResponse, 'currency'),
                    'amount': parseFloat (withdrawResponse, 'amount'),
                    'minimum': parseFloat (withdrawResponse, 'minimum'),
                    'maximum': parseFloat (withdrawResponse, 'maximum'),
                    'percentage': parseFloat (withdrawResponse, 'percentage'),
                };
            } else {
                withdrawResponse = await this.privateGet1PaymentPayoutFeeCrypto (request);
                withdrawFees[code] = {
                    'recomended': parseFloat (this.safeValue (withdrawResponse, 'recomended')),
                    'minimum': parseFloat (this.safeValue (withdrawResponse, 'minimum')),
                    'maximum': parseFloat (this.safeValue (withdrawResponse, 'maxmimum')),
                    'feeExpireTime': (this.safeValue (withdrawResponse, 'feeExpireTime')),
                    'feeId': this.safeValue (withdrawResponse, 'feeId'),
                };
            }
            info[code] = {
                'withdraw': withdrawResponse,
            };
        }
        return {
            'withdraw': withdrawFees,
            'info': info,
        };
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
            const askPrice = this.safeFloat (currency, 'ask');
            const bidPrice = this.safeFloat (currency, 'bid');
            result[code] = {
                'id': id,
                'info': currency,
                'code': code,
                'active': true,
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
        for (let i = 0; i < response.length; i++) {
            const marketId = this.safeString (response[i], 'symbol');
            const market = this.safeMarket (marketId);
            const symbol = market['symbol'];
            result[symbol] = this.parseTicker (response[i], market);
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

    async fetchTrades (symbol, since = undefined, limit = undefined, params = {}) {
        // OR IF ITS FORMATTED
        // [
        //     {"date":1393492619000,"price":"575.64","amount":"0.02","tid":"3814483"},
        //     {"date":1393492619001,"price":"574.30","amount":"0.12","tid":"3814482"},
        //     {"date":1393492619002,"price":"573.67","amount":"3.80","tid":"3814481"},
        //     {"date":1393492619003,"price":"571.00","amount":"0.01","tid":"3814479"},
        //     ...
        //   ]
        await this.loadMarkets ();
        if (symbol === undefined) {
            throw new ArgumentsRequired (this.id + ' fetchTrades () requires a symbol argument');
        }
        const market = this.market (symbol);
        const request = {
            'symbol': market['id'],
            'formatItem': 'object', // safer to parse
        };
        const response = await this.publicGetTradesSymbol (this.extend (request, params));
        const trades = this.safeValue (response, 'trades', []);
        const result = [];
        for (let i = 0; i < trades.length; i++) {
            result[i] = this.parsePublicTrade (trades[i], symbol);
        }
        return result;
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
        const account = await this.getAccountId (params);
        const response = await this.privateGet1PaymentAccounts (params);
        const allAccounts = this.safeValue (response, 'accounts', {});
        let selectedAccount = {};
        for (let i = 0; i < allAccounts.length; i++) {
            if (this.safeString (allAccounts[i], 'account') === account) {
                selectedAccount = allAccounts[i];
                break;
            }
        }
        const balances = this.safeValue (selectedAccount, 'balance', []);
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

    async fetchOrder (id, symbol = undefined, params = {}) {
        await this.loadMarkets ();
        await this.loadAccounts ();
        const clientOrderId = this.safeString2 (params, 'clientOrderId', 'client_oid');
        if (clientOrderId === undefined) {
            // client-generated id required not orderId
            throw new ArgumentsRequired (this.id + ' fetchOrder () requires a client order if argument');
        }
        const request = {
            'clientOrderId': clientOrderId,
            'account': await this.getAccountId (params),
        };
        params = this.omit (params, ['clientOrderId', 'client_oid']);
        const market = this.market (symbol);
        const response = await this.privateGet1TradingOrder (this.extend (request, params));
        const responseData = this.safeValue (response, 'orders', []);
        const order = this.safeValue (responseData, 0, {});
        return this.parseOrder (order, market);
    }

    async createOrder (symbol, type, side, amount, price = undefined, params = {}) {
        await this.loadMarkets ();
        await this.loadAccounts ();
        const market = this.market (symbol);
        const request = {
            'account': await this.getAccountId (params),
            'type': type,
            'side': side,
            'symbol': market['id'],
            'quantity': this.amountToPrecision (symbol, amount).toString (),
        };
        const expireTime = this.safeValue (params, 'expireTime');
        if (expireTime) {
            request['expireTime'] = expireTime;
        }
        if (!expireTime && type === 'GTD') {
            throw new InvalidOrder (this.id + ' createOrder method requires a expireTime or expireIn param for a ' + type);
        }
        const stopPrice = this.safeFloat2 (params, 'stopPrice', 'stop_price');
        if (stopPrice !== undefined && (type === 'stop' || type === 'stopLimit')) {
            request['stopPrice'] = this.priceToPrecision (symbol, stopPrice).toString ();
            params = this.omit (params, [ 'stopPrice', 'stop_price' ]);
        }
        if (type === 'limit') {
            if (!price) {
                throw new InvalidOrder (this.id + ' price is required in Limit orders');
            }
        }
        request['price'] = this.priceToPrecision (symbol, price).toString ();
        const response = await this.privatePost1TradingNewOrder (this.extend (request, params));
        const order = this.safeValue (response, 'ExecutionReport', {});
        return this.parseExecutedOrder (order, market);
    }

    async cancelOrder (id, symbol = undefined, params = {}) {
        if (id === undefined) {
            throw new ArgumentsRequired (this.id + ' cancelOrder () requires a clientOrderId argument');
        }
        await this.loadMarkets ();
        await this.loadAccounts ();
        const market = this.market (symbol);
        const request = {
            'clientOrder_Id': id,
            'account': await this.getAccountId (params),
        };
        const response = await this.privatePost2TradingCancelOrder (this.extend (request, params));
        const responseData = this.safeValue (response, 'ExecutionReport', {});
        if (responseData) {
            return this.parseExcecutedOrder (responseData, market);
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
            'account': await this.getAccountId (params),
        };
        let market = undefined;
        if (symbol !== undefined) {
            market = this.market (symbol);
            request['symbols'] = market['symbol']; // the request will be more performant if you include it
        }
        return await this.privatePost1TradingCancelOrders (this.extend (request, params));
    }

    async fetchOrders (symbol = undefined, since = undefined, limit = undefined, params = {}) {
        await this.loadMarkets ();
        let market = undefined;
        const request = {
            'account': await this.getAccountId (params),
        };
        if (symbol !== undefined) {
            market = this.market (symbol);
            request['symbols'] = market['id'];
        }
        const maxResults = this.safeValue (params, 'maxResults');
        if (!maxResults) {
            request['maxResults'] = 1000;
        }
        const response = await this.privateGet1TradingOrdersRecent (this.extend (request, params));
        const orders = this.safeValue (response, 'orders', []);
        return this.parseOrders (orders, market, since, limit);
    }

    async fetchOpenOrders (symbol = undefined, since = undefined, limit = undefined, params = {}) {
        await this.loadMarkets ();
        await this.loadAccounts ();
        const request = {
            'account': await this.getAccountId (params),
        };
        let market = undefined;
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
            'statuses': 'filled,canceled,expired,suspended',
        };
        const orders = await this.fetchOrders (symbol, since, limit, this.extend (request, params));
        return this.filterBy (orders, 'status', 'closed');
    }

    async fetchMyTrades (symbol = undefined, since = undefined, limit = undefined, params = {}) {
        await this.loadMarkets ();
        let market = undefined;
        const request = {
            'account': await this.getAccountId (params),
        };
        // can be multiple values comma separated, default is all
        if (symbol !== undefined) {
            market = this.market (symbol);
            request['symbols'] = market['id'];
        }
        const by = this.safeValue (params, 'by');
        if (!by) {
            request['by'] = 'ts';
        }
        const startIndex = this.safeValue (params, 'startIndex');
        if (!startIndex) {
            request['startIndex'] = 0;
        }
        const maxResults = this.safeValue (params, 'maxResults');
        if (!maxResults) {
            request['maxResults'] = 1000;
        }
        const response = await this.privateGet1TradingTrades (this.extend (request, params));
        const orders = this.safeValue (response, 'trades', []);
        return this.parseTrades (orders, market, since, limit);
    }

    async withdraw (code, amount, address, tag = undefined, params = {}) {
        let response = {};
        this.checkAddress (address);
        await this.loadMarkets ();
        const currency = this.currency (code);
        // Common parameters
        let request = {
            'currency': currency['id'],
            'amount': amount.toString (),
        };
        request = this.extend (request, params);
        const requestTime = this.safeValue (request, 'requestTime');
        if (!requestTime) {
            throw new ArgumentsRequired (this.id + ' requires requestTime parameter to withdraw ');
        }
        // check if it is fiat
        if (this.isFiatSymbol (code)) {
            // bank transfer
            const bankRequest = await this.getBankTransferRequest (request);
            response = await this.privatePost1PaymentPayoutBank (bankRequest);
        } else {
            // crypto transfer
            const cryptoRequest = await this.getCryptoTransferRequest (address, request, params);
            response = await this.privatePost1PaymentPayoutCrypto (cryptoRequest);
        }
        return {
            'info': response,
            'id': this.safeValue (response, 'transactionCode'),
        };
    }

    async getCryptoTransferRequest (address, request) {
        request['address'] = address;
        const account = await this.getAccountId (request);
        request['account'] = account;
        const commission = this.safeValue (request, 'commission');
        if (!commission) {
            throw new ArgumentsRequired (this.id + ' requires commission parameter to withdraw ');
        }
        request['commission'] = commission;
        // Create messageSigning
        const message = 'requestTime=' + this.safeValue (request, 'requestTime') + '&amount=' + this.safeValue (request, 'amount') + '&currency=' + this.safeValue (request, 'currency') + '&account=' + this.safeValue (request, 'account') + '&address=' + this.safeValue (request, 'address') + '&commission=' + this.safeValue (request, 'commission');
        const transactionSignature = this.signMessage (message);
        request['transactionSignature'] = transactionSignature;
        return request;
    }

    async getBankTransferRequest (request) {
        const accountFrom = await this.getAccountId (request);
        request['account'] = accountFrom;
        const paymentType = this.safeValue (request, 'paymentType');
        if (!paymentType) {
            throw new ArgumentsRequired (this.id + ' requires paymentType parameter to withdraw ');
        }
        // IBAN ACCOUNT
        const beneficiaryAccount = this.safeValue (request, 'beneficiaryAccount');
        if (!beneficiaryAccount) {
            throw new ArgumentsRequired (this.id + ' requires beneficiaryAccount parameter to withdraw ');
        }
        const beneficiaryAccountType = this.safeValue (request, 'beneficiaryAccountType');
        // IBAN ACCOUNT NAME
        const beneficiaryName = this.safeValue (request, 'beneficiaryName');
        if (!beneficiaryName && beneficiaryAccountType === 'other') {
            throw new ArgumentsRequired (this.id + ' requires beneficiaryName parameter to withdraw when beneficiaryAccountType is other');
        }
        if (paymentType === 'internacional') {
            const beneficiarySwiftCode = this.safeValue (request, 'beneficiarySwiftCode');
            if (!beneficiarySwiftCode) {
                throw new ArgumentsRequired (this.id + ' requires beneficiarySwiftCode parameter to withdraw for International transfers');
            }
        }
        // both or none
        const intermediaryAccount = this.safeValue (request, 'intermediaryAccount');
        const intermediarySwiftCode = this.safeValue (request, 'intermediarySwiftCode');
        if (intermediaryAccount || intermediarySwiftCode) {
            if (!intermediaryAccount) {
                throw new ArgumentsRequired (this.id + ' requires intermediaryAccount parameter to withdraw when intermediarySwiftCode exists');
            }
            if (!intermediarySwiftCode) {
                throw new ArgumentsRequired (this.id + ' requires intermediarySwiftCode parameter to withdraw when intermediaryAccount exists');
            }
        }
        // Create messageSigning
        const message = 'requestTime=' + this.safeValue (request, 'requestTime') + 'accountFrom=' + this.safeValue (request, 'account') + '&amount=' + this.safeValue (request, 'ammount') + '&currency=' + this.safeValue (request, 'currency') + '&beneficiaryName=' + this.safeValue (request, 'beneficiaryName') + '&beneficiaryAccount=' + this.safeValue (request, 'beneficiaryAccount');
        const transactionSignature = this.signMessage (message);
        request['transactionSignature'] = transactionSignature;
        return request;
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
        const price = this.safeFloat (order, 'orderPrice');
        const average = this.safeFloat (order, 'avgPrice');
        const amount = this.safeFloat (order, 'orderQuantity');
        const filled = this.safeFloat (order, 'execQuantity');
        const timeInForce = this.safeString (order, 'timeInForce');
        const remaining = this.safeValue (order, 'quantityLeaves');
        const cost = filled * average;
        const res = {
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
        return res;
    }

    parseExecutedOrder (order, market = undefined) {
        //     {
        //     "orderId":"58521038",
        //     "clientOrderId":"fe02900d762ad2458a942ce5d126c7b2",
        //     "orderStatus":"new",
        //     "symbol":"BTCEUR",
        //     "side":"sell",
        //     "price":"553.08",
        //     "quantity":"0.00030",
        //     "type":"limit",
        //     "timeInForce":"GTC",
        //     "lastQuantity":"0.00000",
        //     "lastPrice":"",
        //     "leavesQuantity":"0.00030",
        //     "cumQuantity":"0.00000",
        //     "averagePrice":"0",
        //     "created":1480067768415,
        //     "execReportType":"new",
        //     "timestamp":1480067768415,
        //     "account":"VER564A02",
        //     "orderSource": "REST"
        //     }
        // }
        const id = this.safeString (order, 'orderId');
        const side = this.safeString (order, 'side');
        const status = this.safeString (order, 'orderStatus');
        const marketId = this.safeString (order, 'symbol');
        market = this.safeMarket (marketId, market);
        const timestamp = this.safeTimestamp (order, 'timestamp');
        const clientOrderId = this.safeString (order, 'clientOrderId');
        const price = this.safeFloat (order, 'price');
        const average = this.safeFloat (order, 'averagePrice');
        const amount = this.safeFloat (order, 'quantity');
        const filled = this.safeFloat (order, 'cumQuantity');
        const type = this.safeValue (order, 'type');
        const timeInForce = this.safeString (order, 'timeInForce');
        const remaining = this.safeFloat (order, 'leavesQuantity');
        const cost = filled * average;
        const res = {
            'info': order,
            'id': id,
            'clientOrderId': clientOrderId,
            'timestamp': timestamp,
            'datetime': this.iso8601 (timestamp),
            'lastTradeTimestamp': undefined,
            'symbol': market['symbol'],
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
            'type': type,
            'trades': undefined,
        };
        return res;
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
            'bid': this.safeFloat (ticker, 'bid'),
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

    parsePublicTrade (trade, symbol = undefined) {
        const timestamp = this.safeValue (trade, 'timestamp');
        const amount = this.safeFloat (trade, 'amount');
        const price = this.safeFloat (trade, 'price');
        const side = this.safeString (trade, 'side');
        let cost = undefined;
        if (price !== undefined) {
            if (amount !== undefined) {
                cost = price * amount;
            }
        }
        return {
            'id': this.safeValue (trade, 'tid'),
            'price': price,
            'amount': amount,
            'timestamp': timestamp,
            'datetime': this.iso8601 (timestamp),
            'info': trade,
            'side': side,
            'cost': cost,
            'fee': undefined,
            'takerOrMaker': undefined,
            'order': undefined,
            'symbol': symbol,
            'type': undefined,
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
            'order': originalOrderId,
            'type': type,
            'side': side,
            'takerOrMaker': undefined,
            'price': price,
            'amount': amount,
            'cost': cost,
            'fee': fee,
        };
    }

    async getAccountId (params) {
        const requestAccount = this.safeValue (params, 'account');
        if (requestAccount) {
            return requestAccount;
        }
        await this.loadAccounts ();
        const defaultAccount = this.safeValue (this.accounts, 0, {});
        const defaultAccountId = this.safeValue (defaultAccount, 'id');
        if (!defaultAccountId) {
            throw new ArgumentsRequired (this.id + ' requires at least the default Account number ');
        }
        return defaultAccountId;
    }

    isFiatSymbol (symb) {
        return symb === 'EUR' || symb === 'USD';
    }

    signMessage (message) {
        return this.hmac (this.encode (message), this.encode (this.secret), 'sha512');
    }

    sign (path, api = 'public', method = 'GET', params = {}, headers = undefined, body = undefined) {
        let url = this.urls['api'][api]; // + '/';
        const uri = this.implodeParams (path, params);
        const query = this.omit (params, this.extractParams (path));
        const privateUrl = url.split ('.com')[1] + uri; // not pretty but url.pathname not supported in python
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
            const nonce = this.nonce ().toString ();
            const message = this.apiKey + '&' + nonce + privateUrl + request;
            headers = {
                'Content-Type': 'application/x-www-form-urlencoded',
                'X-API-Key': this.apiKey,
                'X-Nonce': nonce,
                'X-Signature': this.signMessage (message),
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
