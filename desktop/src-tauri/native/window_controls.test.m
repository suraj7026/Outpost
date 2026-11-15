#import <Cocoa/Cocoa.h>
#include <assert.h>

extern void outpost_set_window_controls(void *, bool, double, double);
extern bool outpost_sidebar_pointer_inside(void *, double);
extern bool outpost_set_window_blur(void *, unsigned int);

@interface SidebarFixtureWindow : NSWindow
@property NSPoint testPointer;
@end
@implementation SidebarFixtureWindow
- (NSPoint)mouseLocationOutsideOfEventStream { return self.testPointer; }
- (BOOL)isVisible { return YES; }
- (BOOL)isMiniaturized { return NO; }
@end

static CGFloat buttonSpacing;

static void assertPosition(NSWindow *window, bool visible, CGFloat x, CGFloat centerY) {
    NSUInteger index = 0;
    for (NSNumber *kind in @[@(NSWindowCloseButton), @(NSWindowMiniaturizeButton), @(NSWindowZoomButton)]) {
        NSButton *button = [window standardWindowButton:kind.unsignedIntegerValue];
        assert(button && button.hidden == !visible);
        if (visible) {
            NSRect rect = [button.superview convertRect:button.frame toView:window.contentView];
            CGFloat y = window.contentView.flipped ? NSMidY(rect) : NSHeight(window.contentView.bounds) - NSMidY(rect);
            assert(fabs(NSMinX(rect) - (x + index * buttonSpacing)) < .1);
            assert(fabs(y - centerY) < .1);
            assert(NSWidth(button.superview.superview.frame) < 130);
        }
        index++;
    }
}

int main(void) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
        SidebarFixtureWindow *window = [[SidebarFixtureWindow alloc]
            initWithContentRect:NSMakeRect(0, 0, 1320, 850)
            styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
                NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable |
                NSWindowStyleMaskFullSizeContentView
            backing:NSBackingStoreBuffered defer:NO];
        window.titlebarAppearsTransparent = YES;
        window.titleVisibility = NSWindowTitleHidden;
        NSRect defaultZoomFrame = [window standardWindowButton:NSWindowZoomButton].frame;
        buttonSpacing = MAX(20, [window standardWindowButton:NSWindowMiniaturizeButton].frame.origin.x - [window standardWindowButton:NSWindowCloseButton].frame.origin.x);
        void *pointer = (__bridge void *)window;
        for (NSNumber *visible in @[@NO, @YES, @NO]) {
            outpost_set_window_controls(pointer, visible.boolValue, 29, 35);
            for (NSNumber *kind in @[@(NSWindowCloseButton), @(NSWindowMiniaturizeButton), @(NSWindowZoomButton)]) {
                NSButton *button = [window standardWindowButton:kind.unsignedIntegerValue];
                assert(button != nil);
                assert(button.hidden == !visible.boolValue);
                if (visible.boolValue) {
                    NSRect contentRect = [button.superview convertRect:button.frame toView:window.contentView];
                    CGFloat top = window.contentView.flipped ? NSMinY(contentRect) : NSHeight(window.contentView.bounds) - NSMaxY(contentRect);
                    assert(NSMinX(contentRect) >= 29 && NSMaxX(contentRect) <= 110);
                    assert(top >= 24 && top <= 30);
                    assert(NSWidth(button.superview.superview.frame) < 130);
                }
            }
        }
        // No frontend calls inside these resize/layout cycles: AppKit must keep
        // the last requested anchor synchronously, including titlebar relayout.
        for (NSNumber *visible in @[@YES, @NO, @YES]) {
            outpost_set_window_controls(pointer, visible.boolValue, 29, 35);
            for (NSNumber *width in @[@1320, @1151, @1150, @901, @900, @901, @1151, @1600, @1320]) {
                [window setContentSize:NSMakeSize(width.doubleValue, width.doubleValue / 2 + 150)];
                assertPosition(window, visible.boolValue, 29, 35);
                [window.contentView.superview layoutSubtreeIfNeeded];
                assertPosition(window, visible.boolValue, 29, 35);
                [window update];
                assertPosition(window, visible.boolValue, 29, 35);
            }
        }
        // AppKit can restore button frames independently of a resize event.
        NSButton *close = [window standardWindowButton:NSWindowCloseButton];
        [close setFrameOrigin:NSMakePoint(7, 4)];
        assertPosition(window, true, 29, 35);
        // Simulate AppKit restoring only the zoom widget after a focus callback.
        NSButton *zoom = [window standardWindowButton:NSWindowZoomButton];
        zoom.postsFrameChangedNotifications = NO;
        zoom.frame = defaultZoomFrame;
        assert(NSEqualRects(zoom.frame, defaultZoomFrame));
        [[NSNotificationCenter defaultCenter] postNotificationName:NSWindowDidResignKeyNotification object:window];
        assertPosition(window, true, 29, 35);
        zoom.frame = defaultZoomFrame;
        [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:.05]];
        assertPosition(window, true, 29, 35);
        zoom.postsFrameChangedNotifications = YES;
        outpost_set_window_controls(pointer, false, 29, 35);
        [window setContentSize:NSMakeSize(900, 600)];
        assertPosition(window, false, 29, 35);
        CGFloat height = NSHeight(window.contentView.bounds);
        window.testPointer = NSMakePoint(26, height - 26);
        assert(outpost_sidebar_pointer_inside(pointer, 250));
        window.testPointer = NSMakePoint(240, 300);
        assert(outpost_sidebar_pointer_inside(pointer, 250));
        window.testPointer = NSMakePoint(600, 300);
        assert(!outpost_sidebar_pointer_inside(pointer, 250));
        window.testPointer = NSMakePoint(-1, 300);
        assert(!outpost_sidebar_pointer_inside(pointer, 250));
        window.testPointer = NSMakePoint(26, height + 10);
        assert(!outpost_sidebar_pointer_inside(pointer, 250));
        assert(outpost_set_window_blur(pointer, 6));
        assert(outpost_set_window_blur(pointer, 32));
        assert(outpost_set_window_blur(pointer, 0));
        assert(outpost_set_window_blur(pointer, 6));
        puts("PASS: native AppKit button visibility, synchronous resize/layout anchoring and sidebar/traffic-light hit testing (no visible window or Accessibility permission).");
        puts("PASS: the window compositor accepts the light, strong, off, and restored blur radii.");
    }
    return 0;
}
