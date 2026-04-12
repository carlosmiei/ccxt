package examples;

import io.github.ccxt.exchanges.pro.Binance;

import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.List;
import java.util.Map;

/**
 * Watch real-time OHLCV (candlestick) updates via WebSocket.
 * Shows the latest candles as they update in real-time.
 *
 * Usage:
 *   cd java && ./gradlew :examples:run -PmainClass=examples.WatchOHLCV
 *   cd java && ./gradlew :examples:run -PmainClass=examples.WatchOHLCV --args="ETH/USDT 5m"
 */
public class WatchOHLCV {

    static final DateTimeFormatter FMT = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")
            .withZone(ZoneId.systemDefault());

    @SuppressWarnings("unchecked")
    public static void main(String[] args) throws Exception {
        String symbol = args.length > 0 ? args[0] : "BTC/USDT";
        String timeframe = args.length > 1 ? args[1] : "1m";

        Binance exchange = new Binance();
        exchange.verbose = false;

        System.out.println("Loading markets...");
        exchange.loadMarkets().join();
        System.out.println("Watching " + symbol + " OHLCV (" + timeframe + ", 15 updates)...\n");

        System.out.printf("%-18s %12s %12s %12s %12s %14s%n",
                "Date", "Open", "High", "Low", "Close", "Volume");
        System.out.println("-".repeat(82));

        for (int i = 0; i < 15; i++) {
            List<List<Object>> candles = (List<List<Object>>) exchange.watchOHLCV(symbol, timeframe).join();

            // Print the latest candle
            if (!candles.isEmpty()) {
                List<Object> c = candles.get(candles.size() - 1);
                long timestamp = ((Number) c.get(0)).longValue();
                String date = FMT.format(Instant.ofEpochMilli(timestamp));
                double open = ((Number) c.get(1)).doubleValue();
                double high = ((Number) c.get(2)).doubleValue();
                double low = ((Number) c.get(3)).doubleValue();
                double close = ((Number) c.get(4)).doubleValue();
                double volume = ((Number) c.get(5)).doubleValue();
                System.out.printf("%-18s %12.2f %12.2f %12.2f %12.2f %14.4f%n",
                        date, open, high, low, close, volume);
            }
        }

        System.out.println("\nDone!");
        System.exit(0);
    }
}
