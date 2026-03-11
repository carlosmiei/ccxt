// -------------------------------------------------------------------------------
// Polymarket abstract interface
// -------------------------------------------------------------------------------

import { implicitReturnType } from '../base/types.js';
import { Exchange as _Exchange } from '../base/Exchange.js';

interface Exchange {
    // Gamma API (market metadata)
    gammaPublicGetEvents (params?: {}): Promise<implicitReturnType>;
    gammaPublicGetEventsId (params?: {}): Promise<implicitReturnType>;
    gammaPublicGetEventsSlugSlug (params?: {}): Promise<implicitReturnType>;
    gammaPublicGetMarkets (params?: {}): Promise<implicitReturnType>;
    gammaPublicGetMarketsId (params?: {}): Promise<implicitReturnType>;
    gammaPublicGetPublicSearch (params?: {}): Promise<implicitReturnType>;

    // CLOB API (order book and market data - public)
    clobPublicGetBook (params?: {}): Promise<implicitReturnType>;
    clobPublicGetPricesHistory (params?: {}): Promise<implicitReturnType>;
    clobPublicGetDataTrades (params?: {}): Promise<implicitReturnType>;
    clobPublicGetPrice (params?: {}): Promise<implicitReturnType>;
    clobPublicGetMidpoint (params?: {}): Promise<implicitReturnType>;
    clobPublicGetSpread (params?: {}): Promise<implicitReturnType>;

    // CLOB API (order management - private)
    clobPrivateGetDataOrders (params?: {}): Promise<implicitReturnType>;
    clobPrivateGetDataOrderId (params?: {}): Promise<implicitReturnType>;
    clobPrivatePostOrder (params?: {}): Promise<implicitReturnType>;
    clobPrivateDeleteOrder (params?: {}): Promise<implicitReturnType>;
    clobPrivateDeleteOrders (params?: {}): Promise<implicitReturnType>;

    // Data API (user data - private)
    dataPrivateGetPositions (params?: {}): Promise<implicitReturnType>;
    dataPrivateGetTrades (params?: {}): Promise<implicitReturnType>;
    dataPrivateGetValue (params?: {}): Promise<implicitReturnType>;
}

abstract class Exchange extends _Exchange {}

export default Exchange;
