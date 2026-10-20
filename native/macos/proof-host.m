#import <AppKit/AppKit.h>
int main(void) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        NSDictionary *info = NSBundle.mainBundle.infoDictionary;
        NSString *line = [NSString stringWithFormat:@"%@ %d\n", info[@"CFBundleVersion"], getpid()];
        NSFileHandle *file = [NSFileHandle fileHandleForWritingAtPath:info[@"ProofMarker"]];
        [file seekToEndOfFile]; [file writeData:[line dataUsingEncoding:NSUTF8StringEncoding]]; [file closeFile];
        [NSApp run];
    }
}
