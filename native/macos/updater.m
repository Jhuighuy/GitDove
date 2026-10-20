#import <AppKit/AppKit.h>
#import <Sparkle/Sparkle.h>

static void emit(NSDictionary *event) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:event options:0 error:nil];
    fwrite(data.bytes, 1, data.length, stdout);
    fputc('\n', stdout);
    fflush(stdout);
}

@interface Bridge : NSObject <SPUUserDriver, SPUUpdaterDelegate>
@property SPUUpdater *updater;
@property NSString *version;
@property(copy) void (^installReply)(SPUUserUpdateChoice);
@property uint64_t downloaded;
@property uint64_t expected;
@property BOOL installing;
@end

@implementation Bridge
- (void)showUpdatePermissionRequest:(SPUUpdatePermissionRequest *)request reply:(void (^)(SUUpdatePermissionResponse *))reply {
    reply([[SUUpdatePermissionResponse alloc] initWithAutomaticUpdateChecks:NO sendSystemProfile:NO]);
}
- (BOOL)updaterShouldPromptForPermissionToCheckForUpdates:(SPUUpdater *)updater { return NO; }
- (void)showUserInitiatedUpdateCheckWithCancellation:(void (^)(void))cancellation { emit(@{@"kind": @"checking"}); }
- (void)showUpdateFoundWithAppcastItem:(SUAppcastItem *)item state:(SPUUserUpdateState *)state reply:(void (^)(SPUUserUpdateChoice))reply {
    self.version = item.displayVersionString;
    if (item.informationOnlyUpdate) { reply(SPUUserUpdateChoiceDismiss); return; }
    if (state.stage == SPUUserUpdateStageInstalling) { [self showReadyToInstallAndRelaunch:reply]; return; }
    emit(@{@"kind": @"available", @"version": self.version});
    reply(SPUUserUpdateChoiceInstall);
}
- (void)showUpdateReleaseNotesWithDownloadData:(SPUDownloadData *)data {}
- (void)showUpdateReleaseNotesFailedToDownloadWithError:(NSError *)error {}
- (void)showUpdateNotFoundWithError:(NSError *)error acknowledgement:(void (^)(void))acknowledgement { emit(@{@"kind": @"idle"}); acknowledgement(); }
- (void)showUpdaterError:(NSError *)error acknowledgement:(void (^)(void))acknowledgement {
    fprintf(stderr, "%s\n", error.description.UTF8String);
    emit(@{@"kind": @"error", @"message": error.localizedDescription}); acknowledgement();
}
- (void)showDownloadInitiatedWithCancellation:(void (^)(void))cancellation { emit(@{@"kind": @"downloading", @"percent": @0}); }
- (void)showDownloadDidReceiveExpectedContentLength:(uint64_t)length { self.expected = length; self.downloaded = 0; }
- (void)showDownloadDidReceiveDataOfLength:(uint64_t)length {
    self.downloaded += length;
    if (self.expected) emit(@{@"kind": @"downloading", @"percent": @(MIN(100, 100.0 * self.downloaded / self.expected))});
}
- (void)showDownloadDidStartExtractingUpdate {}
- (void)showExtractionReceivedProgress:(double)progress {}
- (void)showReadyToInstallAndRelaunch:(void (^)(SPUUserUpdateChoice))reply {
    self.installReply = reply;
    emit(@{@"kind": @"ready", @"version": self.version ?: @"unknown"});
}
- (void)showInstallingUpdateWithApplicationTerminated:(BOOL)terminated retryTerminatingApplication:(void (^)(void))retry {
    self.installing = YES;
    emit(@{@"kind": @"installing"});
}
- (void)showUpdateInstalledAndRelaunched:(BOOL)relaunched acknowledgement:(void (^)(void))acknowledgement {
    emit(@{@"kind": @"installed", @"relaunched": @(relaunched)}); acknowledgement(); exit(0);
}
- (void)dismissUpdateInstallation {}
- (void)updater:(SPUUpdater *)updater didFinishUpdateCycleForUpdateCheck:(SPUUpdateCheck)check error:(NSError *)error {
    if (error && error.code != SUNoUpdateError) {
        fprintf(stderr, "%s\n", error.description.UTF8String);
        emit(@{@"kind": @"error", @"message": error.localizedDescription}); exit(1);
    }
    if (!self.installReply && !self.installing) exit(0);
}
@end

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc != 2) return 2;
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
        NSBundle *host = [NSBundle bundleWithPath:@(argv[1])];
        if (!host) return 2;
        Bridge *bridge = [Bridge new];
        bridge.updater = [[SPUUpdater alloc] initWithHostBundle:host applicationBundle:host userDriver:bridge delegate:bridge];
        NSError *error = nil;
        if (![bridge.updater startUpdater:&error]) { emit(@{@"kind": @"error", @"message": error.localizedDescription}); return 1; }
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
            char line[32]; size_t size = 0; char byte;
            while (read(STDIN_FILENO, &byte, 1) == 1) {
                if (byte != '\n') { if (size < sizeof(line)) line[size++] = byte; else exit(2); continue; }
                NSString *command = [[NSString alloc] initWithBytes:line length:size encoding:NSUTF8StringEncoding];
                size = 0;
                dispatch_async(dispatch_get_main_queue(), ^{
                    if ([command isEqualToString:@"install"] && bridge.installReply) {
                        bridge.installing = YES;
                        void (^reply)(SPUUserUpdateChoice) = bridge.installReply;
                        bridge.installReply = nil;
                        reply(SPUUserUpdateChoiceInstall);
                    }
                });
            }
            dispatch_async(dispatch_get_main_queue(), ^{ if (!bridge.installing) exit(0); });
        });
        [bridge.updater checkForUpdates];
        [NSApp run];
    }
    return 0;
}
