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
    func testInvalidPageDoesNotPartiallyApply() throws {
        var projection = Projection()
        let initial = ServerRecord(id: "task", kind: "task", revision: 1, data: ["goal": .string("Original")], updatedAt: "2026-10-28")
        try projection.replace(Snapshot(protocolVersion: 1, cursor: 1, records: [initial]))
        let changed = ServerRecord(id: "task", kind: "task", revision: 2, data: ["goal": .string("Changed")], updatedAt: "2026-10-28")
        let page = EventPage(events: [WireEvent(protocolVersion: 1, eventId: "two", feedCursor: 2, payload: changed), WireEvent(protocolVersion: 99, eventId: "three", feedCursor: 3, payload: changed)], nextCursor: 3, hasMore: false)
        XCTAssertThrowsError(try projection.apply(page))
        XCTAssertEqual(projection.cursor, 1)
        XCTAssertEqual(projection.records["task:task"], initial)
        try projection.apply(EventPage(events: [], nextCursor: 4, hasMore: false))
        XCTAssertEqual(projection.cursor, 4) // Private records legitimately leave feed gaps.
    }
    func testCompleteFeatureOwnership() {
        XCTAssertEqual(FeatureCatalogue.all.count, 270)
        XCTAssertEqual(Set(FeatureCatalogue.all.map(\.id)).count, 270)
    }
}
