// -------------------------------------------------------------------------------
// Kalshi abstract interface
// -------------------------------------------------------------------------------

import { implicitReturnType } from '../base/types.js';
import { Exchange as _Exchange } from '../base/Exchange.js';

interface Exchange {
    // Public market data
    kalshiPublicGetEvents (params?: {}): Promise<implicitReturnType>;
    kalshiPublicGetEventsEventTicker (params?: {}): Promise<implicitReturnType>;
    kalshiPublicGetSeries (params?: {}): Promise<implicitReturnType>;
    kalshiPublicGetSeriesSeriesTicker (params?: {}): Promise<implicitReturnType>;
    kalshiPublicGetMarkets (params?: {}): Promise<implicitReturnType>;
    kalshiPublicGetMarketsTicker (params?: {}): Promise<implicitReturnType>;
    kalshiPublicGetMarketsTickerOrderbook (params?: {}): Promise<implicitReturnType>;
    kalshiPublicGetMarketsTrades (params?: {}): Promise<implicitReturnType>;
    kalshiPublicGetSeriesSeriesTickerMarketsTickerCandlesticks (params?: {}): Promise<implicitReturnType>;

    // Private portfolio endpoints
    kalshiPrivateGetPortfolioBalance (params?: {}): Promise<implicitReturnType>;
    kalshiPrivateGetPortfolioOrders (params?: {}): Promise<implicitReturnType>;
    kalshiPrivateGetPortfolioOrdersOrderId (params?: {}): Promise<implicitReturnType>;
    kalshiPrivateGetPortfolioPositions (params?: {}): Promise<implicitReturnType>;
    kalshiPrivateGetPortfolioFills (params?: {}): Promise<implicitReturnType>;
    kalshiPrivatePostPortfolioOrders (params?: {}): Promise<implicitReturnType>;
    kalshiPrivateDeletePortfolioOrdersOrderId (params?: {}): Promise<implicitReturnType>;
    kalshiPrivateDeletePortfolioOrders (params?: {}): Promise<implicitReturnType>;
}

abstract class Exchange extends _Exchange {}

export default Exchange;
