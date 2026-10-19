import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

public class AvighnaaWhiteBoxTest {

    AvighnaaWhiteBox avighnaa = new AvighnaaWhiteBox();

    // Test For Loop
    @Test
    void testForLoop() {
        int[] values = {10, 20, 30};

        assertEquals(60, avighnaa.calculateSensorSum(values));
    }

    // Test Switch Case
    @Test
    void testSwitchCase() {
        assertEquals("NORMAL", avighnaa.getSensorStatus(1));
        assertEquals("WARNING", avighnaa.getSensorStatus(2));
        assertEquals("CRITICAL", avighnaa.getSensorStatus(3));
        assertEquals("UNKNOWN", avighnaa.getSensorStatus(5));
    }

    // Test Do-While
    @Test
    void testDoWhile() {
        assertEquals(3, avighnaa.countAttempts(3));
    }

    // Test If-Else
    @Test
    void testIfElse() {
        assertEquals("HIGH", avighnaa.checkTemperature(45));
        assertEquals("NORMAL", avighnaa.checkTemperature(30));
    }
}