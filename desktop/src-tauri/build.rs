fn main() {
    #[cfg(target_os = "macos")]
    {
        cc::Build::new()
            .file("native/sidebar.m")
            .flag("-fobjc-arc")
            .flag("-mmacosx-version-min=14.0")
            .compile("outpost_sidebar");
        println!("cargo:rustc-link-lib=framework=AppKit");
        println!("cargo:rerun-if-changed=native/sidebar.m");
    }
    tauri_build::build()
}
