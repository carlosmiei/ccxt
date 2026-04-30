// -------------------------------------------------------------------------------
// Myriad abstract interface
// -------------------------------------------------------------------------------

import { implicitReturnType } from '../base/types.js';
import { Exchange as _Exchange } from '../base/Exchange.js';

interface Exchange {
    // Public market/question data
    myriadPublicGetQuestions (params?: {}): Promise<implicitReturnType>;
    myriadPublicGetQuestionsId (params?: {}): Promise<implicitReturnType>;
    myriadPublicGetMarkets (params?: {}): Promise<implicitReturnType>;
    myriadPublicGetMarketsId (params?: {}): Promise<implicitReturnType>;
    myriadPublicGetMarketsNetworkIdId (params?: {}): Promise<implicitReturnType>;
    myriadPublicGetMarketsIdEvents (params?: {}): Promise<implicitReturnType>;

    // Private trading endpoints
    myriadPrivatePostMarketsQuote (params?: {}): Promise<implicitReturnType>;
}

abstract class Exchange extends _Exchange {}

export default Exchange;
