// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    match lume_lib::cli::try_run_embedded_from_env() {
        Ok(true) => {}
        Ok(false) => lume_lib::run(),
        Err(err) => {
            eprintln!("{}", err);
            std::process::exit(1);
        }
    }
}
