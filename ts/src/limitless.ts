/// <reference lib="es2015" />
// ---------------------------------------------------------------------------
//
// Limitless CCXT Exchange adapter  (https://limitless.exchange)
//
// Hierarchy:  Group markets (events) → Child markets → YES/NO outcomes
//
// Each child market becomes one CCXT market with an outcomes list:
//   market.id:     slug
//   market.symbol: SLUG_SHORT
//   outcomes[i].symbol: SLUG_SHORT:YES  /  SLUG_SHORT:NO
//
// Sizes in the order book are in USDC micro-units (6 decimals) → ÷ 1_000_000.
//
// ---------------------------------------------------------------------------

import Exchange from './abstract/limitless.js';
import type {
    Int, Str, Num, Dict,
    Market, Ticker, OrderBook, OHLCV,
    Order, Position, PredictionEvent,
} from './base/types.js';
import { ArgumentsRequired } from '../ccxt.js';
import { Precise } from './base/Precise.js';
import { sha256 } from './static_dependencies/noble-hashes/sha256.js';

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
                '1h': '1h',
                '6h': '6h',
                '1d': '1d',
                '1w': '1w',
                '1M': '1m',
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
                            'markets/active/{categoryId}': 1,
                            'markets/{addressOrSlug}': 1,
                            'markets/categories/count': 1,
                            'markets/active/slugs': 1,
                            'markets/search': 1,
                            'markets/{slug}/orderbook': 1,
                            'markets/{slug}/historical-price': 1,
                            'auth/signing-message': 1,
                            'markets/{addressOrSlug}/oracle-candles': 1,
                            'markets/{slug}/get-feed-events': 1,
                            'markets/{slug}/events': 1,
                            'navigation': 1,
                            'market-pages/by-path': 1,
                            'market-pages/{id}/markets': 1,
                            'property-keys': 1,
                            'property-keys/{id}': 1,
                            'property-keys/{id}/options': 1,
                            'portfolio/{account}/traded-volume': 1,
                            'portfolio/{account}/positions': 1,
                            'portfolio/{account}/pnl-chart': 1,
                        },
                    },
                    'private': {
                        'get': {
                            'auth/api-keys': 1,
                            'markets/{slug}/user-orders': 1,
                            'portfolio/positions': 1,
                            'portfolio/trades': 1,
                            'markets/{slug}/locked-balance': 1,
                            'profiles/{account}': 1,
                            'portfolio/pnl-chart': 1,
                            'portfolio/history': 1,
                            'portfolio/points': 1,
                            'portfolio/trading/allowance': 1,
                            'auth/api-tokens/capabilities': 1,
                            'auth/api-tokens': 1,
                            'profiles/partner-accounts/{profileId}/allowances': 1,
                        },
                        'post': {
                            'auth/logout': 1,
                            'auth/api-keys': 1,
                            'auth/login': 1,
                            'orders': 1,
                            'orders/cancel-batch': 1,
                            'orders/status/batch': 1,
                            'portfolio/redeem': 1,
                            'portfolio/withdraw': 1,
                            'auth/api-tokens/derive': 1,
                            'profiles/partner-accounts': 1,
                            'profiles/partner-accounts/{profileId}/allowances/retry': 1,
                        },
                        'delete': {
                            'auth/api-keys': 1,
                            'orders/{order_id}': 1,
                            'orders/all/{slug}': 1,
                            'auth/api-tokens/{tokenId}': 1,
                        },
                    },
                },
            },
            'requiredCredentials': {
                'apiKey': true,   // Limitless API key
                'secret': true,
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
    // Markets — one CCXT market per child market, outcomes list inside
    // -----------------------------------------------------------------------

    /**
     * Fetches all active Limitless markets paginated and returns one CCXT market per child market,
     * each containing a list of outcome objects (YES/NO).
     * @param params
     * @see https://docs.limitless.exchange/api-reference/markets/get-active-markets
     */
    async fetchMarkets (params: Dict = {}): Promise<Market[]> {
        const queries = this.safeList (params, 'queries', []) as string[];
        const rest = this.omit (params, [ 'queries' ]);
        let allRaw: any[] = [];
        if (queries && queries.length > 0) {
            const limit = this.safeInteger (rest, 'limit', 50);
            const searchRest = this.omit (rest, [ 'limit' ]);
            const seen: Dict = {};
            for (const q of queries) {
                const response = await this.limitlessPublicGetMarketsSearch (this.extend ({ 'query': q, 'limit': limit }, searchRest));
                const found = this.safeList (response, 'markets', []) as any[];
                for (const raw of found) {
                    const slug = this.safeString (raw, 'slug');
                    if (slug && !seen[slug]) {
                        seen[slug] = true;
                        allRaw.push (raw);
                    }
                }
            }
        } else {
            let page = 1;
            const pageSize = this.safeInteger (this.options, 'marketsPageSize', 25);
            const request: Dict = {
                'page': page,
                'limit': pageSize,
            };
            const firstPageResponse = await this.limitlessPublicGetMarketsActive (this.extend (request, rest));
            const totalMarketsCount = this.safeInteger (firstPageResponse, 'totalMarketsCount');
            const firstData = this.safeList (firstPageResponse, 'data', []);
            allRaw = this.flatten (firstData, allRaw);
            const promises = [];
            const totalPages = Math.ceil (totalMarketsCount / pageSize);
            for (let i = 2; i <= totalPages; i++) {
                page = i;
                request['page'] = page;
                promises.push (this.limitlessPublicGetMarketsActive (this.extend (request, rest)));
            }
            const responses = await Promise.all (promises);
            const length = responses.length;
            for (let j = 0; j < length; j++) {
                const response = this.safeDict (responses, j);
                const data = this.safeList (response, 'data', []);
                allRaw = this.flatten (data, allRaw);
            }
            const lastPageResponse = this.safeDict (responses, length - 1);
            const lastPageData = this.safeList (lastPageResponse, 'data', []);
            const lastPageLength = lastPageData.length;
            let hasMore = true;
            if (lastPageLength < pageSize) {
                hasMore = false;
            }
            while (hasMore) {
                page++;
                request['page'] = page;
                const response = await this.limitlessPublicGetMarketsActive (this.extend (request, rest));
                const page_markets = (this.safeList (response, 'data', response as any) || []) as any[];
                if (!page_markets || page_markets.length === 0) {
                    break;
                }
                for (const raw of page_markets) {
                    allRaw.push (raw);
                }
                hasMore = page_markets.length >= pageSize;
            }
        }
        const markets: Market[] = [];
        const eventGroups: Dict = {};
        for (const raw of allRaw) {
            const groupId = this.safeString (raw, 'groupId', this.safeString (raw, 'slug'));
            const eventKey = groupId ? this.shortenSlug (groupId) : undefined;
            const m = this.parseMarket (raw);
            markets.push (m);
            if (eventKey) {
                if (!eventGroups[eventKey]) {
                    eventGroups[eventKey] = { 'groupId': groupId, 'title': this.safeString (raw, 'title', groupId), 'raw': raw, 'markets': [] };
                }
                (eventGroups[eventKey] as Dict)['markets'].push (m);
            }
        }
        const eventsDict: Dict = {};
        for (const eventKey of Object.keys (eventGroups)) {
            const g = eventGroups[eventKey] as Dict;
            eventsDict[eventKey] = this.parseEvent (g);
        }
        this.events = eventsDict;
        return markets;
    }

    parseMarket (raw: Dict): Market {
        //
        // {
        //   "id":"36814",
        //   "automationType":"manual",
        //   "conditionId":"0x11287d02d8067ff3d3d8bd21b212ebcfdc20b638f7f6440e4115f649e6b57015",
        //   "negRiskRequestId":null,
        //   "description":"<p>This market will resolve to “Yes” if Donald Trump resigns or is removed as President or otherwise ceases to be the President of the United States for any period of time by December 31, 2026, 11:59 PM ET. Otherwise, this market will resolve to “No”.</p><p>An announcement of Donald Trump's resignation/removal before this market's end date will immediately resolve this market to \\""Yes\\"", regardless of when the announced resignation/removal goes into effect.</p><p>Only permanent removal from office will qualify. Temporary removal (e.g. temporary invocation of the 25th Amendment under Section 3 or a Section 4 invocation not sustained by both Houses of Congress) or impeachment without removal will not count.</p><p>A sustained invocation of the Twenty-Fifth Amendment, Section 4 (i.e., if both Houses of Congress, by two-thirds vote, uphold the Vice President and Cabinet’s determination of presidential inability) will qualify for a \\""Yes\\"" resolution.</p><p>The resolution source for this market will be a consensus of credible reporting.</p>",
        //   "collateralToken":{
        //       "address":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        //       "decimals":"6",
        //       "symbol":"USDC"
        //   },
        //   "title":"💎 Trump out as President before 2027?",
        //   "proxyTitle":null,
        //   "expirationDate":"Jan 1, 2027",
        //   "expirationTimestamp":"1798779540000",
        //   "createdAt":"2026-01-20T18:17:48.298Z",
        //   "updatedAt":"2026-02-24T17:00:11.833Z",
        //   "categories":[
        //       "Politics"
        //   ],
        //   "status":"FUNDED",
        //   "expired":false,
        //   "hidden":false,
        //   "creator":{
        //       "name":"Limitless",
        //       "imageURI":"https://limitless.exchange/assets/images/logo.svg",
        //       "link":"https://x.com/trylimitless"
        //   },
        //   "tags":[
        //       "Limitless"
        //   ],
        //   "volume":"290091252",
        //   "volumeFormatted":"290.091252",
        //   "tokens":{
        //       "yes":"56154308742753982686710750162015444986563701968079760676518531584453506363044",
        //       "no":"32572248812801208874557774576516861470423415416073401354576860825663488568217"
        //   },
        //   "prices":[
        //       0.164,
        //       0.836
        //   ],
        //   "isOther":false,
        //   "isRewardable":true,
        //   "slug":"trump-out-as-president-before-2027-1768933068297",
        //   "tradeType":"clob",
        //   "venue":{
        //       "exchange":"0x05c748E2f4DcDe0ec9Fa8DDc40DE6b867f923fa5",
        //       "adapter":null
        //   },
        //   "marketType":"single",
        //   "priorityIndex":"0",
        //   "winningOutcomeIndex":null,
        //   "metadata":{
        //       "fee":true,
        //       "isBannered":false,
        //       "isPolyArbitrage":true
        //   },
        //   "trends":{
        //       "hourly":{
        //           "value":"3",
        //           "rank":"395"
        //       }
        //   },
        //   "settings":{
        //       "minSize":"100000000",
        //       "maxSpread":"0.035",
        //       "dailyReward":"5",
        //       "rewardsEpoch":"0.003472222222222222",
        //       "c":"3",
        //       "rebateRate":"0"
        //   },
        //   "imageUrl":"https://cdn.limitless.exchange/markets-logo/36814/9daba01d-6bcd-4a2c-9187-f4264b7191da.png",
        //   "logo":"https://cdn.limitless.exchange/markets-logo/36814/9daba01d-6bcd-4a2c-9187-f4264b7191da.png"
        // }
        //
        const slug = this.safeString (raw, 'slug');
        const address = this.safeString (raw, 'address', slug);
        const groupId = this.safeString (raw, 'groupId', slug);
        const tokens = this.safeValue (raw, 'tokens', {});
        const active = this.safeBool (raw, 'active', true);
        const endDate = this.safeString (raw, 'deadline', this.safeString (raw, 'expiresAt'));
        const volume24h = this.safeNumber (raw, 'volume24h');
        const marketSymbol = this.slugToMarketSymbol (groupId, slug);
        const outcomes: any[] = [];
        const tokenEntries = Object.keys (tokens);
        for (const outcomeLabel of tokenEntries) {
            const tokenData = tokens[outcomeLabel];
            const tokenId = tokenData;
            outcomes.push ({
                'id': tokenId,
                'symbol': this.slugToOutcomeSymbol (groupId, slug, outcomeLabel),
                'marketSymbol': marketSymbol,
                'label': outcomeLabel,
                'active': active,
                'info': {
                    'slug': slug,
                    'address': address,
                    'outcomeLabel': outcomeLabel,
                    'tokenId': tokenId,
                    'volume24h': volume24h,
                },
            });
        }
        return {
            'id': slug,
            'symbol': marketSymbol,
            'base': slug,
            'quote': 'USDC',
            'settle': undefined,
            'baseId': slug,
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
            'outcomes': outcomes,
            'info': this.extend (raw, {
                'slug': slug,
                'address': address,
                'volume24h': volume24h,
            }),
            'created': undefined,
        };
    }

    parseEvent (event: Dict): PredictionEvent {
        // {
        //    "groupId":"trump-out-as-president-before-2027-1768933068297",
        //    "title":"💎 Trump out as President before 2027?",
        //    "raw":{
        //       "id":"36814",
        //       "automationType":"manual",
        //       "conditionId":"0x11287d02d8067ff3d3d8bd21b212ebcfdc20b638f7f6440e4115f649e6b57015",
        //       "negRiskRequestId":null,
        //       "description":"<p>This market will resolve to “Yes” if Donald Trump resigns or is removed as President or otherwise ceases to be the President of the United States for any period of time by December 31, 2026, 11:59 PM ET. Otherwise, this market will resolve to “No”.</p><p>An announcement of Donald Trump's resignation/removal before this market's end date will immediately resolve this market to \\""Yes\\"", regardless of when the announced resignation/removal goes into effect.</p><p>Only permanent removal from office will qualify. Temporary removal (e.g. temporary invocation of the 25th Amendment under Section 3 or a Section 4 invocation not sustained by both Houses of Congress) or impeachment without removal will not count.</p><p>A sustained invocation of the Twenty-Fifth Amendment, Section 4 (i.e., if both Houses of Congress, by two-thirds vote, uphold the Vice President and Cabinet’s determination of presidential inability) will qualify for a \\""Yes\\"" resolution.</p><p>The resolution source for this market will be a consensus of credible reporting.</p>",
        //       "collateralToken":{
        //          "address":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        //          "decimals":"6",
        //          "symbol":"USDC"
        //       },
        //       "title":"💎 Trump out as President before 2027?",
        //       "proxyTitle":null,
        //       "expirationDate":"Jan 1, 2027",
        //       "expirationTimestamp":"1798779540000",
        //       "createdAt":"2026-01-20T18:17:48.298Z",
        //       "updatedAt":"2026-02-24T17:00:11.833Z",
        //       "categories":[
        //          "Politics"
        //       ],
        //       "status":"FUNDED",
        //       "expired":false,
        //       "hidden":false,
        //       "creator":{
        //          "name":"Limitless",
        //          "imageURI":"https://limitless.exchange/assets/images/logo.svg",
        //          "link":"https://x.com/trylimitless"
        //       },
        //       "tags":[
        //          "Limitless"
        //       ],
        //       "volume":"290091252",
        //       "volumeFormatted":"290.091252",
        //       "tokens":{
        //          "yes":"56154308742753982686710750162015444986563701968079760676518531584453506363044",
        //          "no":"32572248812801208874557774576516861470423415416073401354576860825663488568217"
        //       },
        //       "prices":[
        //          0.164,
        //          0.836
        //       ],
        //       "isOther":false,
        //       "isRewardable":true,
        //       "slug":"trump-out-as-president-before-2027-1768933068297",
        //       "tradeType":"clob",
        //       "venue":{
        //          "exchange":"0x05c748E2f4DcDe0ec9Fa8DDc40DE6b867f923fa5",
        //          "adapter":null
        //       },
        //       "marketType":"single",
        //       "priorityIndex":"0",
        //       "winningOutcomeIndex":null,
        //       "metadata":{
        //          "fee":true,
        //          "isBannered":false,
        //          "isPolyArbitrage":true
        //       },
        //       "trends":{
        //          "hourly":{
        //             "value":"3",
        //             "rank":"395"
        //          }
        //       },
        //       "settings":{
        //          "minSize":"100000000",
        //          "maxSpread":"0.035",
        //          "dailyReward":"5",
        //          "rewardsEpoch":"0.003472222222222222",
        //          "c":"3",
        //          "rebateRate":"0"
        //       },
        //       "imageUrl":"https://cdn.limitless.exchange/markets-logo/36814/9daba01d-6bcd-4a2c-9187-f4264b7191da.png",
        //       "logo":"https://cdn.limitless.exchange/markets-logo/36814/9daba01d-6bcd-4a2c-9187-f4264b7191da.png"
        //    },
        //    "markets":[
        //       {
        //          "id":"trump-out-as-president-before-2027-1768933068297",
        //          "symbol":"TRUMP_OUT_PRESIDENT_2027_1768933068297",
        //          "base":"trump-out-as-president-before-2027-1768933068297",
        //          "quote":"USDC",
        //          "baseId":"trump-out-as-president-before-2027-1768933068297",
        //          "quoteId":"USDC",
        //          "type":"prediction",
        //          "spot":false,
        //          "margin":false,
        //          "swap":false,
        //          "future":false,
        //          "option":false,
        //          "prediction":true,
        //          "active":true,
        //          "contract":false,
        //          "taker":0.02,
        //          "maker":0.02,
        //          "percentage":true,
        //          "tierBased":false,
        //          "feeSide":"get",
        //          "precision":{
        //             "amount":0.000001,
        //             "price":0.001
        //          },
        //          "limits":{
        //             "leverage":{
        //                "min":1,
        //                "max":1
        //             },
        //             "amount":{
        //                "min":0
        //             },
        //             "price":{
        //                "min":0.001,
        //                "max":0.999
        //             },
        //             "cost":{

        //             }
        //          },
        //          "outcomes":[
        //             {
        //                "id":"trump-out-as-president-before-2027-1768933068297/yes",
        //                "symbol":"TRUMP_OUT_PRESIDENT_2027_1768933068297:YES",
        //                "marketSymbol":"TRUMP_OUT_PRESIDENT_2027_1768933068297",
        //                "label":"yes",
        //                "active":true,
        //                "info":{
        //                   "slug":"trump-out-as-president-before-2027-1768933068297",
        //                   "address":"trump-out-as-president-before-2027-1768933068297",
        //                   "outcomeLabel":"yes",
        //                   "tokenId":"trump-out-as-president-before-2027-1768933068297/yes"
        //                }
        //             },
        //             {
        //                "id":"trump-out-as-president-before-2027-1768933068297/no",
        //                "symbol":"TRUMP_OUT_PRESIDENT_2027_1768933068297:NO",
        //                "marketSymbol":"TRUMP_OUT_PRESIDENT_2027_1768933068297",
        //                "label":"no",
        //                "active":true,
        //                "info":{
        //                   "slug":"trump-out-as-president-before-2027-1768933068297",
        //                   "address":"trump-out-as-president-before-2027-1768933068297",
        //                   "outcomeLabel":"no",
        //                   "tokenId":"trump-out-as-president-before-2027-1768933068297/no"
        //                }
        //             }
        //          ],
        //          "info":{
        //             "id":"36814",
        //             "automationType":"manual",
        //             "conditionId":"0x11287d02d8067ff3d3d8bd21b212ebcfdc20b638f7f6440e4115f649e6b57015",
        //             "negRiskRequestId":null,
        //             "description":"<p>This market will resolve to “Yes” if Donald Trump resigns or is removed as President or otherwise ceases to be the President of the United States for any period of time by December 31, 2026, 11:59 PM ET. Otherwise, this market will resolve to “No”.</p><p>An announcement of Donald Trump's resignation/removal before this market's end date will immediately resolve this market to \\""Yes\\"", regardless of when the announced resignation/removal goes into effect.</p><p>Only permanent removal from office will qualify. Temporary removal (e.g. temporary invocation of the 25th Amendment under Section 3 or a Section 4 invocation not sustained by both Houses of Congress) or impeachment without removal will not count.</p><p>A sustained invocation of the Twenty-Fifth Amendment, Section 4 (i.e., if both Houses of Congress, by two-thirds vote, uphold the Vice President and Cabinet’s determination of presidential inability) will qualify for a \\""Yes\\"" resolution.</p><p>The resolution source for this market will be a consensus of credible reporting.</p>",
        //             "collateralToken":{
        //                "address":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        //                "decimals":"6",
        //                "symbol":"USDC"
        //             },
        //             "title":"💎 Trump out as President before 2027?",
        //             "proxyTitle":null,
        //             "expirationDate":"Jan 1, 2027",
        //             "expirationTimestamp":"1798779540000",
        //             "createdAt":"2026-01-20T18:17:48.298Z",
        //             "updatedAt":"2026-02-24T17:00:11.833Z",
        //             "categories":[
        //                "Politics"
        //             ],
        //             "status":"FUNDED",
        //             "expired":false,
        //             "hidden":false,
        //             "creator":{
        //                "name":"Limitless",
        //                "imageURI":"https://limitless.exchange/assets/images/logo.svg",
        //                "link":"https://x.com/trylimitless"
        //             },
        //             "tags":[
        //                "Limitless"
        //             ],
        //             "volume":"290091252",
        //             "volumeFormatted":"290.091252",
        //             "tokens":{
        //                "yes":"56154308742753982686710750162015444986563701968079760676518531584453506363044",
        //                "no":"32572248812801208874557774576516861470423415416073401354576860825663488568217"
        //             },
        //             "prices":[
        //                0.164,
        //                0.836
        //             ],
        //             "isOther":false,
        //             "isRewardable":true,
        //             "slug":"trump-out-as-president-before-2027-1768933068297",
        //             "tradeType":"clob",
        //             "venue":{
        //                "exchange":"0x05c748E2f4DcDe0ec9Fa8DDc40DE6b867f923fa5",
        //                "adapter":null
        //             },
        //             "marketType":"single",
        //             "priorityIndex":"0",
        //             "winningOutcomeIndex":null,
        //             "metadata":{
        //                "fee":true,
        //                "isBannered":false,
        //                "isPolyArbitrage":true
        //             },
        //             "trends":{
        //                "hourly":{
        //                   "value":"3",
        //                   "rank":"395"
        //                }
        //             },
        //             "settings":{
        //                "minSize":"100000000",
        //                "maxSpread":"0.035",
        //                "dailyReward":"5",
        //                "rewardsEpoch":"0.003472222222222222",
        //                "c":"3",
        //                "rebateRate":"0"
        //             },
        //             "imageUrl":"https://cdn.limitless.exchange/markets-logo/36814/9daba01d-6bcd-4a2c-9187-f4264b7191da.png",
        //             "logo":"https://cdn.limitless.exchange/markets-logo/36814/9daba01d-6bcd-4a2c-9187-f4264b7191da.png",
        //             "address":"trump-out-as-president-before-2027-1768933068297"
        //          }
        //       }
        //    ]
        // }
        const groupId = this.safeString (event, 'address', this.safeString (event, 'groupId', this.safeString (event, 'slug')));
        const endDate = this.safeString (event, 'deadline', this.safeString (event, 'expiresAt'));
        const title = this.safeString (event, 'title', groupId);
        const markets = [];
        const rawMarkets = this.safeList (event, 'markets', []);
        for (let i = 0; i < rawMarkets.length; i++) {
            const rawMarket = rawMarkets[i];
            const marketSymbol = this.safeString (rawMarket, 'symbol');
            const marketOutcomes = this.safeList (rawMarket, 'outcomes');
            if (marketSymbol !== undefined && marketOutcomes !== undefined) {
                markets.push (rawMarket);
            } else {
                markets.push (this.parseMarket (rawMarket));
            }
        }
        return this.extend ({
            'id': groupId,
            'slug': groupId,
            'symbol': groupId ? this.shortenSlug (groupId) : undefined,
            'title': title,
            'description': this.safeString (event, 'description'),
            'markets': markets,
            'url': this.safeString (event, 'url'),
            'image': this.safeString (event, 'imageUrl', this.safeString (event, 'image')),
            'active': this.safeBool (event, 'active', true),
            'resolved': this.safeBool (event, 'resolved', false),
            'category': this.safeString (event, 'category'),
            'tags': this.safeList (event, 'tags'),
            'created': this.parse8601 (this.safeString (event, 'createdAt')),
            'createdDatetime': this.safeString (event, 'createdAt'),
            'end': endDate ? this.parse8601 (endDate) : undefined,
            'endDatetime': endDate,
            'lastUpdatedAt': this.parse8601 (this.safeString (event, 'updatedAt')),
            'resolutionSource': this.safeString (event, 'resolutionSource'),
            'info': event,
        }) as unknown as PredictionEvent;
    }

    // -----------------------------------------------------------------------
    // Ticker
    // -----------------------------------------------------------------------

    /**
     * Fetches the current price for a single Limitless outcome token from the market endpoint.
     * @param symbol  outcome symbol, e.g. "TRUMP_OUT:YES"
     * @param params
     * @see https://docs.limitless.exchange/api-reference/markets/get-market
     */
    async fetchTicker (symbol: Str, params: Dict = {}): Promise<Ticker> {
        await this.loadMarkets ();
        await this.checkEventsAndMarkets (symbol);
        const outcomeObj = this.outcome (symbol);
        const slug = this.safeString (outcomeObj['info'], 'slug');
        const response = await this.limitlessPublicGetMarketsAddressOrSlug (this.extend ({
            'addressOrSlug': slug,
        }, params));
        return this.parseTicker (response, outcomeObj);
    }

    /**
     * Parses a raw Limitless market object into a unified CCXT Ticker for the specified outcome token.
     * @param raw
     * @param market  outcome object
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
     * @param symbol  outcome symbol, e.g. "TRUMP_OUT:YES"
     * @param limit
     * @param params
     * @see https://docs.limitless.exchange/api-reference/markets/get-orderbook
     */
    async fetchOrderBook (symbol: Str, limit: Int = undefined, params: Dict = {}): Promise<OrderBook> {
        await this.loadMarkets ();
        await this.checkEventsAndMarkets (symbol);
        const outcomeObj = this.outcome (symbol);
        const slug = this.safeString (outcomeObj['info'], 'slug');
        const response = await this.limitlessPublicGetMarketsSlugOrderbook (this.extend ({
            'slug': slug,
        }, params));
        const timestamp = this.milliseconds ();
        const decimals = this.safeInteger (this.options, 'usdcDecimals', 6);
        // scale = 10^decimals; USDC uses 6 decimals → 1_000_000
        const scale = 10 ** decimals;
        const rawBids = this.safeList (response, 'bids', []) as any[];
        const rawAsks = this.safeList (response, 'asks', []) as any[];
        const bids: any[] = [];
        const asks: any[] = [];
        for (let bi = 0; bi < rawBids.length; bi++) {
            const price = this.safeNumber (rawBids[bi], 'price');
            const sizeMicro = this.safeNumber (rawBids[bi], 'size');
            bids.push ([ price, sizeMicro !== undefined ? sizeMicro / scale : undefined ]);
        }
        for (let ai = 0; ai < rawAsks.length; ai++) {
            const price = this.safeNumber (rawAsks[ai], 'price');
            const sizeMicro = this.safeNumber (rawAsks[ai], 'size');
            asks.push ([ price, sizeMicro !== undefined ? sizeMicro / scale : undefined ]);
        }
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
     * Fetches historical prices for a single Limitless market outcome and maps them to OHLCV format.
     * Uses the `interval` query parameter and selects the YES/NO series that matches the requested outcome.
     * @param symbol  outcome symbol, e.g. "TRUMP_OUT:YES"
     * @param timeframe
     * @param since
     * @param limit
     * @param params
     * @see https://docs.limitless.exchange/api-reference/trading/historical-price
     */
    async fetchOHLCV (symbol: Str, timeframe = '1d', since: Int = undefined, limit: Int = undefined, params: Dict = {}): Promise<OHLCV[]> {
        await this.loadMarkets ();
        await this.checkEventsAndMarkets (symbol);
        const outcomeObj = this.outcome (symbol);
        const slug = this.safeString (outcomeObj['info'], 'slug');
        const outcomeLabel = this.safeStringUpper (outcomeObj['info'], 'outcomeLabel');
        const interval = this.safeString (this.timeframes, timeframe, '1d');
        const response = await this.limitlessPublicGetMarketsSlugHistoricalPrice (this.extend ({
            'slug': slug,
            'interval': interval,
        }, params));
        //
        //     {
        //         "data": [
        //             {
        //                  "timestamp": 1705318200000,
        //                  "price": 0.1655
        //             },
        //         ]
        //     }
        //
        //
        //     [
        //         {
        //             "title": "YES Token",
        //             "prices": [
        //                 {
        //                     "price": 0.75,
        //                     "timestamp": "2024-01-15T10:30:00Z"
        //                 },
        //             ]
        //         },
        //         {
        //             "title": "NO Token",
        //             "prices": [
        //                 {
        //                     "price": 0.25,
        //                     "timestamp": "2024-01-15T10:30:00Z"
        //                 }
        //             ]
        //         }
        //     ]
        //
        const rawHistory = (this.safeList (response, 'data', this.safeList (response, 'prices', response as any)) || []) as any[];
        let history: any[] = rawHistory;
        if (rawHistory.length > 0) {
            const first = this.safeDict (rawHistory, 0, {});
            const firstPrices = this.safeList (first, 'prices');
            if (firstPrices !== undefined) {
                let selectedSeries = first;
                for (let i = 0; i < rawHistory.length; i++) {
                    const series = this.safeDict (rawHistory, i, {});
                    const title = this.safeStringUpper (series, 'title', '');
                    if ((outcomeLabel !== undefined) && (title.indexOf (outcomeLabel) >= 0)) {
                        selectedSeries = series;
                        break;
                    }
                }
                history = this.safeList (selectedSeries, 'prices', []);
            }
        }
        return this.parseOHLCVs (history, outcomeObj, timeframe, since, limit);
    }

    /**
     * Parses a single Limitless price tick into a synthetic CCXT OHLCV tuple (all four OHLC fields set to price).
     * @param ohlcv
     * @param market
     */
    parseOHLCV (ohlcv: Dict, market: Market = undefined): OHLCV {
        //
        //     {
        //         "timestamp": 1705318200000,
        //         "price": 0.1655
        //     }
        //
        //     {
        //         "price": 0.75,
        //         "timestamp": "2024-01-15T10:30:00Z"
        //     }
        //
        let ts = this.safeInteger (ohlcv, 'timestamp');
        if (ts === undefined) {
            const tsString = this.safeString (ohlcv, 'timestamp');
            ts = tsString ? this.parse8601 (tsString) : undefined;
        } else if (ts < 1000000000000) {
            // old responses may return unix seconds
            ts *= 1000;
        }
        const price = this.safeNumber (ohlcv, 'price');
        const volume = this.safeNumber (ohlcv, 'volume');
        return [
            ts,
            price, price, price, price,   // synthetic OHLC from single tick
            volume,
        ];
    }

    // -----------------------------------------------------------------------
    // Orders
    // -----------------------------------------------------------------------

    /**
     * Fetches open orders for the authenticated Limitless user, optionally filtered by market slug.
     * @param outcome  outcome symbol, e.g. "TRUMP_OUT:YES"
     * @param since
     * @param limit
     * @param params
     * @see https://docs.limitless.exchange/api-reference/orders/get-user-orders
     */
    async fetchOpenOrders (outcome: Str = undefined, since: Int = undefined, limit: Int = undefined, params: Dict = {}): Promise<Order[]> {
        if (outcome === undefined) {
            throw new ArgumentsRequired (this.id + ' fetchOpenOrders requires an outcome argument');
        }
        await this.loadMarkets ();
        await this.checkEventsAndMarkets (outcome);
        const outcomeObj = this.outcome (outcome);
        const info = this.safeDict (outcomeObj, 'info');
        const request: Dict = {
            'slug': this.safeString (info, 'slug'),
        };
        if (limit !== undefined) {
            request['limit'] = limit;
        }
        const response = await this.limitlessPrivateGetMarketsSlugUserOrders (this.extend (request, params));
        //
        //     [
        //         {
        //             "createdAt": "2026-05-04T08:57:06.448Z",
        //             "id": "c4b1a83a-219f-48db-a9be-1ddadf0bc14c",
        //             "ownerId": 1315134,
        //             "marketId": "112523",
        //             "token": "46235703925185836960484608024734446969378108670784413458211837874003718039438",
        //             "type": "GTC",
        //             "status": "LIVE",
        //             "side": "BUY",
        //             "makerAmount": "1000040",
        //             "takerAmount": "10870000",
        //             "price": "0.092",
        //             "originalSize": "10870000",
        //             "remainingSize": "10870000"
        //         }
        //     ]
        //
        return this.parseOrders (response, outcomeObj as any, since, limit);
    }

    /**
     * Parses a raw Limitless order object into a unified CCXT Order object.
     * @param order
     * @param market  outcome object (optional)
     */
    parseOrder (order: Dict, market: Market = undefined): Order {
        //
        //     {
        //         "createdAt": "2026-05-04T08:57:06.448Z",
        //         "id": "c4b1a83a-219f-48db-a9be-1ddadf0bc14c",
        //         "ownerId": 1315134,
        //         "marketId": "112523",
        //         "token": "46235703925185836960484608024734446969378108670784413458211837874003718039438",
        //         "type": "GTC",
        //         "status": "LIVE",
        //         "side": "BUY",
        //         "makerAmount": "1000040",
        //         "takerAmount": "10870000",
        //         "price": "0.092",
        //         "originalSize": "10870000",
        //         "remainingSize": "10870000"
        //     }
        //
        const id = this.safeString (order, 'id');
        const tokenId = this.safeString (order, 'token');
        const mkt = this.safeOutcome (tokenId, market as any);
        const status = this.parseOrderStatus (this.safeStringLower (order, 'status'));
        const side = this.safeString (order, 'side');
        const price = this.safeString (order, 'price');
        const amount = this.safeString (order, 'originalSize');
        const remaining = this.safeString (order, 'remainingSize');
        const datetime = this.safeString (order, 'createdAt');
        const ts = this.parse8601 (datetime);
        const timeInForce = this.safeString (order, 'type');
        let type = 'limit';
        if (timeInForce === 'FOK') {
            type = 'market';
        }
        return this.safeOrder ({
            'id': id,
            'clientOrderId': undefined,
            'info': order,
            'timestamp': ts,
            'datetime': datetime,
            'lastTradeTimestamp': undefined,
            'status': status,
            'outcome': mkt['symbol'],
            'type': type,
            'timeInForce': timeInForce,
            'postOnly': undefined,
            'side': side,
            'price': price,
            'stopPrice': undefined,
            'triggerPrice': undefined,
            'average': undefined,
            'amount': Precise.stringDiv (amount, '1000000'),  // convert from micro-units
            'cost': undefined,
            'filled': undefined,
            'remaining': Precise.stringDiv (remaining, '1000000'),  // convert from micro-units
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
            'LIVE': 'open',
            'MATCHED': 'closed',
        };
        return this.safeString (statuses, status, status);
    }

    /**
     * Places a limit or market order on Limitless for the given outcome token.
     * @param symbol  outcome symbol, e.g. "TRUMP_OUT:YES"
     * @param type
     * @param side
     * @param amount
     * @param price
     * @param params
     * @see https://docs.limitless.exchange/api-reference/orders/create-order
     */
    async createOrder (symbol: Str, type: Str, side: Str, amount: Num, price: Num = undefined, params: Dict = {}): Promise<Order> {
        await this.loadMarkets ();
        await this.checkEventsAndMarkets (symbol);
        const outcomeObj = this.outcome (symbol);
        const slug = this.safeString (outcomeObj['info'], 'slug');
        const outcomeLabel = this.safeString (outcomeObj['info'], 'outcomeLabel');
        const request: Dict = {
            'marketSlug': slug,
            'outcome': outcomeLabel,
            'side': (side as string).toLowerCase (),
            'size': amount,
            'price': price,
            'orderType': type,
        };
        const response = await this.limitlessPrivatePostOrders (this.extend (request, params));
        return this.parseOrder (response, outcomeObj as any);
    }

    /**
     * Cancels a single open order by ID on Limitless.
     * @param id
     * @param symbol
     * @param params
     * @see https://docs.limitless.exchange/api-reference/orders/cancel-order
     */
    async cancelOrder (id: Str, symbol: Str = undefined, params: Dict = {}): Promise<Order> {
        if (symbol !== undefined) {
            await this.checkEventsAndMarkets (symbol);
        } else {
            await this.checkEventsAndMarkets ();
        }
        const response = await this.limitlessPrivateDeleteOrdersOrderId (this.extend ({ 'order_id': id }, params));
        return this.parseOrder (response);
    }

    /**
     * Cancels all open orders on Limitless, optionally scoped to one market slug.
     * @param symbol  outcome symbol, e.g. "TRUMP_OUT:YES"
     * @param params
     * @see https://docs.limitless.exchange/api-reference/orders/cancel-all-orders
     */
    async cancelAllOrders (symbol: Str = undefined, params: Dict = {}): Promise<Order[]> {
        if (symbol !== undefined) {
            await this.checkEventsAndMarkets (symbol);
        } else {
            await this.checkEventsAndMarkets ();
        }
        const request: Dict = {};
        if (symbol !== undefined) {
            await this.loadMarkets ();
            const outcomeObj = this.outcome (symbol);
            request['marketSlug'] = this.safeString (outcomeObj['info'], 'slug');
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
        if (symbols && symbols.length > 0) {
            for (let i = 0; i < symbols.length; i++) {
                await this.checkEventsAndMarkets (symbols[i]);
            }
        } else {
            await this.checkEventsAndMarkets ();
        }
        const response = await this.limitlessPrivateGetPortfolioPositions (params);
        const positions = this.safeList (response, 'data', []) as any[];
        return this.parsePositions (positions, symbols);
    }

    /**
     * Parses a raw Limitless portfolio position into a unified CCXT Position object.
     * @param position
     * @param market  outcome object (optional)
     */
    parsePosition (position: Dict, market: Market = undefined): Position {
        const slug = this.safeString (position, 'marketSlug', this.safeString (position, 'slug'));
        const outcome = this.safeString (position, 'outcome');
        const ocSymbol = (slug && outcome) ? this.shortenSlug (slug) + ':' + (outcome as string).toUpperCase () : undefined;
        const ocObj = ocSymbol ? this.safeOutcome (ocSymbol, undefined) : undefined;
        const ocOrMkt = ocObj || market;
        const size = this.safeNumber (position, 'size');
        const price = this.safeNumber (position, 'avgPrice');
        const cur = this.safeNumber (position, 'currentPrice');
        return {
            'id': undefined,
            'symbol': ocOrMkt ? ocOrMkt['symbol'] : undefined,
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
    async fetchEvents (queries: string[] = [], params: Dict = {}): Promise<PredictionEvent[]> {
        let result: PredictionEvent[] = [];
        if (!queries || queries.length === 0) {
            await this.loadMarkets ();
            result = Object.values (this.events as Dict) as PredictionEvent[];
        } else {
            const limit = this.safeInteger (params, 'limit', 50);
            const rest = this.omit (params, [ 'limit' ]);
            const seen: Dict = {};
            const rawMarkets: any[] = [];
            for (const q of queries) {
                const response = await this.limitlessPublicGetMarketsSearch (this.extend ({
                    'query': q,
                    'limit': limit,
                }, rest));
                const found = this.safeList (response, 'markets', []) as any[];
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
            const eventGroups: Dict = {};
            for (const raw of rawMarkets) {
                const groupId = this.safeString (raw, 'groupId', this.safeString (raw, 'slug'));
                const eventKey = groupId ? this.shortenSlug (groupId) : undefined;
                const m = this.parseMarket (raw);
                this.markets[m['symbol'] as string] = m;
                if (eventKey) {
                    if (!eventGroups[eventKey]) {
                        eventGroups[eventKey] = { 'groupId': groupId, 'title': this.safeString (raw, 'title', groupId), 'raw': raw, 'markets': [] };
                    }
                    (eventGroups[eventKey] as Dict)['markets'].push (m);
                }
            }
            result = [];
            for (const eventKey of Object.keys (eventGroups)) {
                const g = eventGroups[eventKey] as Dict;
                const ev = this.parseEvent (g);
                (this.events as Dict)[eventKey] = ev;
                result.push (ev);
            }
        }
        this.outcomes = {};
        this.outcomes_by_id = {};
        const marketKeys = Object.keys (this.markets || {});
        for (let i = 0; i < marketKeys.length; i++) {
            const market = this.markets[marketKeys[i]] as Dict;
            const outcomesList = this.safeList (market, 'outcomes', []) as any[];
            for (let j = 0; j < outcomesList.length; j++) {
                const oc = outcomesList[j];
                const ocSymbol = this.safeString (oc, 'symbol');
                if (ocSymbol !== undefined) {
                    this.outcomes[ocSymbol] = oc;
                }
                const ocId = this.safeString (oc, 'id');
                if (ocId !== undefined) {
                    this.outcomes_by_id[ocId] = oc;
                }
            }
        }
        return result;
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
        let url = '/' + this.implodeParams (path as string, params);
        const query = this.omit (params, this.extractParams (path as string));
        const querystring = this.urlencode (query);
        if (method === 'GET' && querystring) {
            url += '?' + querystring;
        }
        headers = this.extend ({
            'Accept': 'application/json',
            'Content-Type': 'application/json',
        }, headers || {});
        let bodyString = '';
        if (method !== 'GET' && querystring) {
            body = query as any;
            bodyString = this.json (body);
        }
        if (access === 'private') {
            this.checkRequiredCredentials ();
            const timestamp = this.iso8601 (this.milliseconds ());
            const payload = timestamp + '\n' + method + '\n' + url + '\n' + bodyString;
            const signature = this.hmac (this.encode (payload), this.base64ToBinary (this.secret), sha256, 'base64');
            headers = this.extend (headers, {
                'lmts-api-key': this.apiKey,
                'lmts-timestamp': timestamp,
                'lmts-signature': signature,
            });
        }
        url = baseUrl + url;
        return { 'url': url, 'method': method, 'body': body, 'headers': headers };
    }
}
