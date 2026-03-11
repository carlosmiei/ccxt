// -------------------------------------------------------------------------------
// Limitless abstract interface
// -------------------------------------------------------------------------------

import { implicitReturnType } from '../base/types.js';
import { Exchange as _Exchange } from '../base/Exchange.js';

interface Exchange {
    // Public market data
    limitlessPublicGetMarketsActive (params?: {}): Promise<implicitReturnType>;
    limitlessPublicGetMarketsAddressOrSlug (params?: {}): Promise<implicitReturnType>;
    limitlessPublicGetMarketsSearch (params?: {}): Promise<implicitReturnType>;
    limitlessPublicGetMarketsSlugOrderbook (params?: {}): Promise<implicitReturnType>;
    limitlessPublicGetMarketsSlugHistoricalPrice (params?: {}): Promise<implicitReturnType>;

    // Private order/portfolio endpoints
    limitlessPrivateGetMarketsSlugUserOrders (params?: {}): Promise<implicitReturnType>;
    limitlessPrivateGetPortfolioPositions (params?: {}): Promise<implicitReturnType>;
    limitlessPrivateGetPortfolioTrades (params?: {}): Promise<implicitReturnType>;
    limitlessPrivatePostOrders (params?: {}): Promise<implicitReturnType>;
    limitlessPrivateDeleteOrdersOrderId (params?: {}): Promise<implicitReturnType>;
    limitlessPrivatePostOrdersCancelBatch (params?: {}): Promise<implicitReturnType>;

    // Auth endpoints
    limitlessPublicGetAuthSigningMessage (params?: {}): Promise<implicitReturnType>;
    limitlessPublicPostAuthLogin (params?: {}): Promise<implicitReturnType>;
}

abstract class Exchange extends _Exchange {}

export default Exchange;
