import XCTest

final class OutpostUITests: XCTestCase {
    @MainActor func testNativeTaskCreationAndEvidence() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launch()
        if app.buttons["Sidebar"].exists { app.buttons["Sidebar"].tap() }
        if app.navigationBars.buttons.element(boundBy: 0).label == "Back" { app.navigationBars.buttons.element(boundBy: 0).tap() }
        let connection = app.staticTexts["Connection"].firstMatch
        if !connection.waitForExistence(timeout: 5) {
            app.navigationBars.buttons.element(boundBy: 0).tap()
        }
        XCTAssertTrue(connection.waitForExistence(timeout: 10)); connection.tap()
        let token = app.secureTextFields["One-time bootstrap token"]
        XCTAssertTrue(token.waitForExistence(timeout: 10)); token.tap(); token.typeText("outpost-ui-fixture-token-0123456789")
        app.buttons["Pair First Device"].tap()
        XCTAssertTrue(app.staticTexts["Connected · server-owned history"].waitForExistence(timeout: 10))
        app.navigationBars.buttons.element(boundBy: 0).tap()
        let newTask = app.buttons["new-task"].firstMatch
        XCTAssertTrue(newTask.waitForExistence(timeout: 5)); newTask.tap()
        let goal = app.descendants(matching: .any)["task-goal"].firstMatch
        XCTAssertTrue(goal.waitForExistence(timeout: 5)); goal.tap(); goal.typeText("Inspect fixture server capacity without making changes")
        app.buttons["create-task"].tap()
        XCTAssertTrue(app.staticTexts["Inspect fixture server capacity without making changes"].firstMatch.waitForExistence(timeout: 10))
        app.buttons["Evidence"].tap()
        let inspect = app.buttons["Inspect Machine"]
        XCTAssertTrue(inspect.waitForExistence(timeout: 10)); inspect.tap()
        app.swipeUp()
        let pending = app.buttons["Approve Once"].waitForExistence(timeout: 10)
        if !pending { print(app.debugDescription) }
        XCTAssertTrue(pending)
        try app.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: "/tmp/outpost-native-review.png"))
        let screenshot = XCTAttachment(screenshot: app.screenshot()); screenshot.name = "Soft Studio — real pending machine action"; screenshot.lifetime = .keepAlways; add(screenshot)
    }
}
