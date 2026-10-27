const { Builder, By } = require("selenium-webdriver");

async function runTests() {

    let driver = await new Builder()
        .forBrowser("chrome")
        .build();

    try {

        // Open Avighnaa login page
        await driver.get(
            "http://127.0.0.1:5501/frontend/index.html"
        );

        // Test 1 - Login page loads
        let title = await driver.getTitle();

        if (title !== "") {
            console.log("Test 1 - Login page loads: PASS");
        } else {
            console.log("Test 1 - Login page loads: FAIL");
        }


        // Test 2 - Email field displayed
        let emailField = await driver.findElement(
            By.id("email")
        );

        if (await emailField.isDisplayed()) {
            console.log("Test 2 - Email field displayed: PASS");
        } else {
            console.log("Test 2 - Email field displayed: FAIL");
        }


        // Test 3 - Password field displayed
        let passwordField = await driver.findElement(
            By.id("password")
        );

        if (await passwordField.isDisplayed()) {
            console.log("Test 3 - Password field displayed: PASS");
        } else {
            console.log("Test 3 - Password field displayed: FAIL");
        }


        // Test 4 - Sign In button displayed
        let signInButton = await driver.findElement(
            By.xpath("//button[contains(., 'Sign In')]")
        );

        if (await signInButton.isDisplayed()) {
            console.log("Test 4 - Sign In button displayed: PASS");
        } else {
            console.log("Test 4 - Sign In button displayed: FAIL");
        }


        // Test 5 - Avighnaa branding visible
        let pageText = await driver
            .findElement(By.tagName("body"))
            .getText();

        if (pageText.includes("Avighnaa")) {
            console.log("Test 5 - Avighnaa branding visible: PASS");
        } else {
            console.log("Test 5 - Avighnaa branding visible: FAIL");
        }

        console.log("Selenium black-box test execution completed.");

    } catch (error) {

        console.log("Test execution error:", error);

    } finally {

        

    }
    await new Promise(resolve => setTimeout(resolve, 10000));
}

runTests();