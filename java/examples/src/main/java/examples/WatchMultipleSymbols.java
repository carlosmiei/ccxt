package examples;

import io.github.ccxt.Exchange;
import io.github.ccxt.exchanges.pro.Binance;

import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

/**
 * Watch tickers for multiple symbols simultaneously via WebSocket.
 * Demonstrates watchTickers() which subscribes to several symbols at once.
 *
 * Usage:
 *   cd java && ./gradlew :examples:run -PmainClass=examples.WatchMultipleSymbols
 */
public class WatchMultipleSymbols {

    @SuppressWarnings("unchecked")
    public static void main(String[] args) throws Exception {
        Exchange exchange = new Binance();
        exchange.verbose = false;

        System.out.println("Loading markets...");
        exchange.loadMarkets().get(60, TimeUnit.SECONDS);

        List<String> symbols = List.of("BTC/USDT", "ETH/USDT", "SOL/USDT", "XRP/USDT", "DOGE/USDT");
        System.out.println("Watching tickers for " + symbols + " (10 updates)...\n");

        for (int i = 0; i < 10; i++) {
            CompletableFuture<Object> future = exchange.watchTickers(symbols);
            Object result = future.get(30, TimeUnit.SECONDS);

            Map<String, Map<String, Object>> tickers = (Map<String, Map<String, Object>>) result;

            System.out.println("=== Update #" + (i + 1) + " ===");
            System.out.printf("%-12s %12s %12s %12s %10s%n",
                    "Symbol", "Last", "Bid", "Ask", "Change%");
            System.out.println("-".repeat(60));

            for (String sym : symbols) {
                Map<String, Object> t = tickers.get(sym);
                if (t != null) {
                    System.out.printf("%-12s %12s %12s %12s %10s%n",
                            t.get("symbol"),
                            t.get("last"),
                            t.get("bid"),
                            t.get("ask"),
                            t.get("percentage"));
                }
            }
            System.out.println();
        }

        System.out.println("Done!");
        System.exit(0);
    }
}
