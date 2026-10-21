public class AvighnaaWhiteBox {

    // For Loop
    public int calculateSensorSum(int[] values) {
        int sum = 0;

        for (int value : values) {
            sum += value;
        }

        return sum;
    }

    // Switch Case
    public String getSensorStatus(int code) {
        switch (code) {
            case 1:
                return "NORMAL";
            case 2:
                return "WARNING";
            case 3:
                return "CRITICAL";
            default:
                return "UNKNOWN";
        }
    }

    // Do-While
    public int countAttempts(int attempts) {
        int count = 0;

        do {
            count++;
            attempts--;
        } while (attempts > 0);

        return count;
    }

    // If-Else
    public String checkTemperature(double temperature) {
        if (temperature > 40) {
            return "HIGH";
        } else {
            return "NORMAL";
        }
    }
}