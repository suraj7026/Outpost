#import <AppKit/AppKit.h>

typedef void (*OutpostNavigationCallback)(const char *);

@interface OutpostSidebar : NSViewController <NSTableViewDataSource, NSTableViewDelegate, NSToolbarDelegate>
@property(nonatomic, strong) NSTableView *table;
@property(nonatomic, copy) NSArray<NSDictionary *> *items;
@property(nonatomic, assign) OutpostNavigationCallback callback;
@property(nonatomic, strong) NSSplitViewController *split;
@property(nonatomic, assign) BOOL updating;
@end

@implementation OutpostSidebar
- (void)loadView {
    NSVisualEffectView *surface = [[NSVisualEffectView alloc] initWithFrame:NSMakeRect(0, 0, 240, 800)];
    surface.material = NSVisualEffectMaterialSidebar;
    surface.blendingMode = NSVisualEffectBlendingModeBehindWindow;
    surface.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    NSScrollView *scroll = [[NSScrollView alloc] initWithFrame:surface.bounds];
    scroll.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    scroll.drawsBackground = NO;
    scroll.hasVerticalScroller = YES;
    self.table = [[NSTableView alloc] initWithFrame:scroll.bounds];
    self.table.headerView = nil;
    self.table.style = NSTableViewStyleSourceList;
    self.table.rowHeight = 34;
    self.table.intercellSpacing = NSMakeSize(0, 2);
    self.table.backgroundColor = NSColor.clearColor;
    self.table.dataSource = self;
    self.table.delegate = self;
    self.table.columnAutoresizingStyle = NSTableViewLastColumnOnlyAutoresizingStyle;
    NSTableColumn *column = [[NSTableColumn alloc] initWithIdentifier:@"navigation"];
    column.width = 230;
    [self.table addTableColumn:column];
    scroll.documentView = self.table;
    [surface addSubview:scroll];
    self.view = surface;
}
- (NSInteger)numberOfRowsInTableView:(NSTableView *)table { return self.items.count; }
- (BOOL)tableView:(NSTableView *)table isGroupRow:(NSInteger)row { return [self.items[row][@"kind"] isEqual:@"section"]; }
- (BOOL)tableView:(NSTableView *)table shouldSelectRow:(NSInteger)row { return ![self tableView:table isGroupRow:row]; }
- (CGFloat)tableView:(NSTableView *)table heightOfRow:(NSInteger)row { return [self tableView:table isGroupRow:row] ? 36 : 34; }
- (NSView *)tableView:(NSTableView *)table viewForTableColumn:(NSTableColumn *)column row:(NSInteger)row {
    NSDictionary *item = self.items[row];
    BOOL group = [self tableView:table isGroupRow:row];
    NSTableCellView *cell = [[NSTableCellView alloc] initWithFrame:NSMakeRect(0, 0, table.bounds.size.width, 34)];
    NSTextField *label = [NSTextField labelWithString:item[@"title"] ?: @""];
    label.font = group ? [NSFont systemFontOfSize:12 weight:NSFontWeightSemibold] : [NSFont systemFontOfSize:14];
    label.textColor = group ? NSColor.secondaryLabelColor : NSColor.labelColor;
    label.lineBreakMode = NSLineBreakByTruncatingTail;
    label.translatesAutoresizingMaskIntoConstraints = NO;
    [cell addSubview:label];
    cell.textField = label;
    CGFloat leading = group ? 10 : 34;
    if (!group) {
        NSImageView *image = [[NSImageView alloc] initWithFrame:NSZeroRect];
        image.image = [NSImage imageWithSystemSymbolName:item[@"icon"] ?: @"text.bubble" accessibilityDescription:nil];
        image.contentTintColor = NSColor.secondaryLabelColor;
        image.translatesAutoresizingMaskIntoConstraints = NO;
        [cell addSubview:image];
        cell.imageView = image;
        [NSLayoutConstraint activateConstraints:@[
            [image.leadingAnchor constraintEqualToAnchor:cell.leadingAnchor constant:9],
            [image.centerYAnchor constraintEqualToAnchor:cell.centerYAnchor],
            [image.widthAnchor constraintEqualToConstant:16], [image.heightAnchor constraintEqualToConstant:16]
        ]];
    }
    [NSLayoutConstraint activateConstraints:@[
        [label.leadingAnchor constraintEqualToAnchor:cell.leadingAnchor constant:leading],
        [label.trailingAnchor constraintEqualToAnchor:cell.trailingAnchor constant:-10],
        [label.centerYAnchor constraintEqualToAnchor:cell.centerYAnchor constant:group ? 5 : 0]
    ]];
    cell.toolTip = item[@"title"];
    return cell;
}
- (void)tableViewSelectionDidChange:(NSNotification *)notification {
    NSInteger row = self.table.selectedRow;
    if (!self.updating && row >= 0 && (NSUInteger)row < self.items.count && self.callback) {
        self.callback([self.items[row][@"id"] UTF8String]);
    }
}
- (NSArray<NSToolbarItemIdentifier> *)toolbarAllowedItemIdentifiers:(NSToolbar *)toolbar { return @[NSToolbarToggleSidebarItemIdentifier, NSToolbarFlexibleSpaceItemIdentifier]; }
- (NSArray<NSToolbarItemIdentifier> *)toolbarDefaultItemIdentifiers:(NSToolbar *)toolbar { return @[NSToolbarToggleSidebarItemIdentifier, NSToolbarFlexibleSpaceItemIdentifier]; }
- (NSToolbarItem *)toolbar:(NSToolbar *)toolbar itemForItemIdentifier:(NSToolbarItemIdentifier)identifier willBeInsertedIntoToolbar:(BOOL)insert {
    if ([identifier isEqual:NSToolbarToggleSidebarItemIdentifier]) {
        NSToolbarItem *item = [[NSToolbarItem alloc] initWithItemIdentifier:identifier];
        item.label = @"Toggle Sidebar";
        item.image = [NSImage imageWithSystemSymbolName:@"sidebar.left" accessibilityDescription:@"Toggle Sidebar"];
        item.target = self.split;
        item.action = @selector(toggleSidebar:);
        return item;
    }
    return nil;
}
@end

static OutpostSidebar *sidebar;

void outpost_install_sidebar(void *rawWindow, void *rawWebview, OutpostNavigationCallback callback) {
    NSWindow *window = (__bridge NSWindow *)rawWindow;
    NSView *webview = (__bridge NSView *)rawWebview;
    NSRect originalFrame = window.frame;
    sidebar = [[OutpostSidebar alloc] init];
    sidebar.items = @[];
    sidebar.callback = callback;
    sidebar.split = [[NSSplitViewController alloc] init];
    NSViewController *content = [[NSViewController alloc] init];
    [webview removeFromSuperview];
    webview.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    content.view = webview;
    NSSplitViewItem *navigation = [NSSplitViewItem sidebarWithViewController:sidebar];
    navigation.minimumThickness = 220;
    navigation.maximumThickness = 320;
    navigation.canCollapse = YES;
    NSSplitViewItem *detail = [NSSplitViewItem splitViewItemWithViewController:content];
    detail.minimumThickness = 560;
    [sidebar.split addSplitViewItem:navigation];
    [sidebar.split addSplitViewItem:detail];
    window.contentViewController = sidebar.split;
    [sidebar.split.splitView setPosition:240 ofDividerAtIndex:0];
    NSToolbar *toolbar = [[NSToolbar alloc] initWithIdentifier:@"OutpostToolbar"];
    toolbar.delegate = sidebar;
    toolbar.displayMode = NSToolbarDisplayModeIconOnly;
    window.toolbar = toolbar;
    window.toolbarStyle = NSWindowToolbarStyleUnified;
    [window setFrame:originalFrame display:YES];
}

void outpost_update_sidebar(const char *json, const char *selected) {
    if (!sidebar) return;
    NSData *data = [[NSString stringWithUTF8String:json] dataUsingEncoding:NSUTF8StringEncoding];
    id items = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    if (![items isKindOfClass:NSArray.class]) return;
    sidebar.updating = YES;
    sidebar.items = items;
    [sidebar.table reloadData];
    NSString *selection = [NSString stringWithUTF8String:selected];
    NSUInteger index = [sidebar.items indexOfObjectPassingTest:^BOOL(NSDictionary *item, NSUInteger idx __unused, BOOL *stop __unused) { return [item[@"id"] isEqual:selection]; }];
    if (index != NSNotFound) [sidebar.table selectRowIndexes:[NSIndexSet indexSetWithIndex:index] byExtendingSelection:NO];
    else [sidebar.table deselectAll:nil];
    sidebar.updating = NO;
}
