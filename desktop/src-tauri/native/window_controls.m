#import <Cocoa/Cocoa.h>
#import <objc/runtime.h>

@interface OutpostWindowControls : NSObject
@property(nonatomic, weak) NSWindow *window;
@property(nonatomic) BOOL visible;
@property(nonatomic) BOOL applying;
@property(nonatomic) BOOL reapplyScheduled;
@property(nonatomic) NSPoint anchor;
@property(nonatomic) CGFloat spacing;
@property(nonatomic, strong) NSHashTable<NSView *> *observedViews;
- (instancetype)initWithWindow:(NSWindow *)window;
- (void)apply;
- (void)reapplyAfterLayout;
@end

@implementation OutpostWindowControls
- (instancetype)initWithWindow:(NSWindow *)window {
    if ((self = [super init])) {
        _window = window;
        _observedViews = [NSHashTable weakObjectsHashTable];
        NSButton *close = [window standardWindowButton:NSWindowCloseButton];
        NSButton *minimize = [window standardWindowButton:NSWindowMiniaturizeButton];
        _spacing = MAX(20, minimize.frame.origin.x - close.frame.origin.x);
        for (NSNotificationName name in @[NSWindowDidResizeNotification, NSWindowDidEndLiveResizeNotification,
                                         NSWindowDidUpdateNotification, NSWindowDidBecomeKeyNotification,
                                         NSWindowDidResignKeyNotification, NSWindowDidDeminiaturizeNotification,
                                         NSWindowDidExitFullScreenNotification]) {
            [[NSNotificationCenter defaultCenter] addObserver:self selector:@selector(geometryChanged:)
                                                        name:name object:window];
        }
    }
    return self;
}
- (void)dealloc {
    [[NSNotificationCenter defaultCenter] removeObserver:self];
}
- (void)watchView:(NSView *)view {
    if (!view || [self.observedViews containsObject:view]) return;
    [self.observedViews addObject:view];
    view.postsFrameChangedNotifications = YES;
    [[NSNotificationCenter defaultCenter] addObserver:self selector:@selector(geometryChanged:)
                                                name:NSViewFrameDidChangeNotification object:view];
}
- (void)geometryChanged:(NSNotification *)notification {
    if (self.applying) return;
    [self apply];
    [self reapplyAfterLayout];
}
- (void)reapplyAfterLayout {
    if (!self.visible || self.reapplyScheduled) return;
    self.reapplyScheduled = YES;
    // AppKit can finish laying out the zoom widget after the window notification.
    __weak OutpostWindowControls *weakSelf = self;
    dispatch_async(dispatch_get_main_queue(), ^{
        OutpostWindowControls *controls = weakSelf;
        controls.reapplyScheduled = NO;
        [controls apply];
    });
}
- (void)apply {
    NSWindow *window = self.window;
    if (!window || self.applying) return;
    NSButton *close = [window standardWindowButton:NSWindowCloseButton];
    NSButton *minimize = [window standardWindowButton:NSWindowMiniaturizeButton];
    NSButton *zoom = [window standardWindowButton:NSWindowZoomButton];
    if (!close || !minimize || !zoom) return;
    self.applying = YES;
    NSArray<NSButton *> *buttons = @[close, minimize, zoom];
    for (NSButton *button in buttons) {
        [self watchView:button];
        if (button.hidden == self.visible) button.hidden = !self.visible;
    }
    NSView *container = close.superview.superview;
    [self watchView:container];
    [self watchView:close.superview];
    if (self.visible) {
        NSView *content = window.contentView;
        NSRect frame = container.frame;
        frame.size.height = self.anchor.y + close.frame.size.height / 2 + 8;
        frame.size.width = self.anchor.x + self.spacing * 2 + close.frame.size.width + 12;
        frame.origin.y = container.superview.flipped ? 0 : NSHeight(container.superview.bounds) - frame.size.height;
        if (!NSEqualRects(container.frame, frame)) container.frame = frame;
        for (NSUInteger index = 0; index < buttons.count; index++) {
            NSButton *button = buttons[index];
            NSRect target = NSMakeRect(self.anchor.x + index * self.spacing,
                content.flipped ? self.anchor.y - button.frame.size.height / 2 : NSHeight(content.bounds) - self.anchor.y - button.frame.size.height / 2,
                button.frame.size.width, button.frame.size.height);
            NSRect local = [button.superview convertRect:target fromView:content];
            if (!NSEqualRects(button.frame, local)) button.frame = local;
        }
    }
    self.applying = NO;
}
@end

void outpost_set_window_controls(void *pointer, bool visible, double x, double centerY) {
    NSWindow *window = (__bridge NSWindow *)pointer;
    static char controlsKey;
    OutpostWindowControls *controls = objc_getAssociatedObject(window, &controlsKey);
    if (!controls) {
        controls = [[OutpostWindowControls alloc] initWithWindow:window];
        objc_setAssociatedObject(window, &controlsKey, controls, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    }
    controls.visible = visible;
    controls.anchor = NSMakePoint(x, centerY);
    // AppKit may restore its default frames during resize/titlebar layout. Keep
    // the last DOM anchor synchronously on the main thread, not via resize IPC.
    [controls apply];
    [window.contentView.superview layoutSubtreeIfNeeded];
    [controls apply];
    [controls reapplyAfterLayout];
}

bool outpost_sidebar_pointer_inside(void *pointer, double width) {
    NSWindow *window = (__bridge NSWindow *)pointer;
    if (!window.visible || window.miniaturized) return false;
    NSPoint point = window.mouseLocationOutsideOfEventStream;
    NSRect bounds = window.contentView.bounds;
    // Includes the native traffic-light row, which doesn't emit DOM pointer events.
    return NSPointInRect(point, NSMakeRect(0, 0, MIN(width, NSWidth(bounds)), NSHeight(bounds)));
}

// AppKit materials add tint and do not expose a behind-window blur radius.
extern int32_t CGSDefaultConnectionForThread(void) __attribute__((weak_import));
extern CGError CGSSetWindowBackgroundBlurRadius(int32_t connection, NSInteger windowNumber, int radius) __attribute__((weak_import));

bool outpost_set_window_blur(void *pointer, unsigned int radius) {
    NSWindow *window = (__bridge NSWindow *)pointer;
    if (!CGSDefaultConnectionForThread || !CGSSetWindowBackgroundBlurRadius || window.windowNumber <= 0) return false;
    return CGSSetWindowBackgroundBlurRadius(CGSDefaultConnectionForThread(), window.windowNumber, (int)radius) == kCGErrorSuccess;
}
