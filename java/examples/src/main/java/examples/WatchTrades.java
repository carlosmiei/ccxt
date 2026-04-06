package examples;

import io.github.ccxt.Exchange;
import io.github.ccxt.exchanges.pro.Binance;

import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

/**
 * Watch real-time trades via WebSocket.
 * Displays live trades as they happen on the exchange.
 *
 * Usage:
 *   cd java && ./gradlew :examples:run -PmainClass=examples.WatchTrades
 *   cd java && ./gradlew :examples:run -PmainClass=examples.WatchTrades --args="ETH/USDT"
 */
public class WatchTrades {

    @SuppressWarnings("unchecked")
    public static void main(String[] args) throws Exception {
        String symbol = args.length > 0 ? args[0] : "BTC/USDT";

        Exchange exchange = new Binance();
        exchange.verbose = false;

        System.out.println("Loading markets...");
        exchange.loadMarkets().get(60, TimeUnit.SECONDS);
        System.out.println("Watching " + symbol + " trades (10 batches)...\n");

        System.out.printf("%-26s %-5s %12s %12s %14s%n",
                "Datetime", "Side", "Price", "Amount", "Cost");
        System.out.println("-".repeat(72));

        int totalTrades = 0;
        for (int i = 0; i < 10; i++) {
            CompletableFuture<Object> future = exchange.watchTrades(symbol);
            Object result = future.get(30, TimeUnit.SECONDS);

            List<Map<String, Object>> trades = (List<Map<String, Object>>) result;

            // Print only the latest trades from this batch
            int start = Math.max(0, trades.size() - 5);
            for (int j = start; j < trades.size(); j++) {
                Map<String, Object> t = trades.get(j);
                System.out.printf("%-26s %-5s %12s %12s %14s%n",
                        t.get("datetime"),
                        t.get("side"),
                        t.get("price"),
                        t.get("amount"),
                        t.get("cost"));
            }
            totalTrades += trades.size();
        }

        System.out.println("\nTotal trades received: " + totalTrades);
        System.out.println("Done!");
        System.exit(0);
    }
}
