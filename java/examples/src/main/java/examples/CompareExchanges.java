package examples;

import io.github.ccxt.Exchange;
import io.github.ccxt.types.Ticker;

/**
 * Compare the price of a symbol across multiple exchanges.
 *
 * Usage:
 *   cd java && ./gradlew :examples:run -PmainClass=examples.CompareExchanges
 */
public class CompareExchanges {

    public static void main(String[] args) {
        String symbol = args.length > 0 ? args[0] : "BTC/USDT";
        String[] exchangeIds = {"binance", "bybit", "okx", "kraken", "bitget"};

        System.out.println("Comparing " + symbol + " across exchanges\n");

        System.out.printf("%-12s %12s %12s %12s %10s%n",
                "Exchange", "Last", "Bid", "Ask", "Spread");
        System.out.println("-".repeat(60));

        for (String id : exchangeIds) {
            try {
                Exchange exchange = Exchange.dynamicallyCreateInstance(id, null);
                exchange.loadMarkets(false);

                Ticker ticker = exchange.fetchTicker(symbol);

                double spread = 0;
                if (ticker.ask != null && ticker.bid != null) {
                    spread = ticker.ask - ticker.bid;
                }

                System.out.printf("%-12s %12.2f %12.2f %12.2f %10.2f%n",
                        id,
                        safe(ticker.last),
                        safe(ticker.bid),
                        safe(ticker.ask),
                        spread);
            } catch (Exception e) {
                System.out.printf("%-12s %s%n", id, "ERROR: " + rootMessage(e));
            }
        }
    }

    static double safe(Double v) { return v != null ? v : 0.0; }

    static String rootMessage(Exception e) {
        Throwable c = e;
        while (c.getCause() != null) c = c.getCause();
        String msg = c.getMessage();
        return msg != null && msg.length() > 60 ? msg.substring(0, 60) + "..." : msg;
    }
}
