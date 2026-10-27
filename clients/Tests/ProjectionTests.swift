import XCTest
@testable import OutpostKit

final class ProjectionTests: XCTestCase {
    func testDuplicateReplayAndVersionRejection() throws {
        let snapshot = try JSONDecoder().decode(Snapshot.self, from: Data(#"{"protocolVersion":1,"cursor":1,"records":[{"kind":"task","id":"one","revision":1,"data":{"goal":"Fixture"},"updatedAt":"2026-10-28"}]}"#.utf8))
        var projection = Projection(); try projection.replace(snapshot)
        let page = try JSONDecoder().decode(EventPage.self, from: Data(#"{"events":[{"protocolVersion":1,"eventId":"e2","feedCursor":2,"payload":{"kind":"task","id":"one","revision":2,"data":{"goal":"Steered"},"updatedAt":"2026-10-28"}}],"nextCursor":2,"hasMore":false}"#.utf8))
        try projection.apply(page); try projection.apply(page)
        XCTAssertEqual(projection.records.count, 1); XCTAssertEqual(projection.records["task:one"]?.title, "Steered")
        XCTAssertEqual(projection.cursor, 2)
        XCTAssertThrowsError(try projection.replace(Snapshot(protocolVersion: 99, cursor: 1, records: [])))
    }
    func testCompleteFeatureOwnership() {
        XCTAssertEqual(FeatureCatalogue.all.count, 270)
        XCTAssertEqual(Set(FeatureCatalogue.all.map(\.id)).count, 270)
    }
}
