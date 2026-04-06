package examples;

import io.github.ccxt.Exchange;
import io.github.ccxt.exchanges.pro.Binance;
import io.github.ccxt.ws.WsOrderBook;

import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

/**
 * Watch real-time order book updates via WebSocket.
 * Each call to watchOrderBook resolves on the next delta update.
 *
 * Usage:
 *   cd java && ./gradlew :examples:run -PmainClass=examples.WatchOrderBook
 *   cd java && ./gradlew :examples:run -PmainClass=examples.WatchOrderBook --args="ETH/USDT"
 */
public class WatchOrderBook {

    @SuppressWarnings("unchecked")
    public static void main(String[] args) throws Exception {
        String symbol = args.length > 0 ? args[0] : "BTC/USDT";

        Exchange exchange = new Binance();
        exchange.verbose = false;

        System.out.println("Loading markets...");
        exchange.loadMarkets().get(60, TimeUnit.SECONDS);
        System.out.println("Watching " + symbol + " order book (10 updates)...\n");

        for (int i = 0; i < 10; i++) {
            CompletableFuture<Object> future = exchange.watchOrderBook(symbol);
            WsOrderBook ob = (WsOrderBook) future.get(30, TimeUnit.SECONDS);

            System.out.println("=== Update #" + (i + 1) + " (ts=" + ob.timestamp + ") ===");
            System.out.printf("%-20s | %-20s%n", "BIDS (price x size)", "ASKS (price x size)");
            System.out.println("-".repeat(43));

            int rows = Math.min(5, Math.min(ob.bids.size(), ob.asks.size()));
            for (int j = 0; j < rows; j++) {
                List<Object> bid = (List<Object>) ob.bids.get(j);
                List<Object> ask = (List<Object>) ob.asks.get(j);
                System.out.printf("%10s x %-8s | %10s x %-8s%n",
                        bid.get(0), bid.get(1),
                        ask.get(0), ask.get(1));
            }

            if (!ob.bids.isEmpty() && !ob.asks.isEmpty()) {
                List<Object> bestBid = (List<Object>) ob.bids.get(0);
                List<Object> bestAsk = (List<Object>) ob.asks.get(0);
                double spread = ((Number) bestAsk.get(0)).doubleValue() - ((Number) bestBid.get(0)).doubleValue();
                System.out.printf("Spread: %.2f  |  Total bids: %d  |  Total asks: %d%n%n",
                        spread, ob.bids.size(), ob.asks.size());
            }
        }

        System.out.println("Done!");
        System.exit(0);
    }
}
