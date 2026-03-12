fn main() {
    if let Err(err) = lume_lib::cli::run_standalone_from_env() {
        eprintln!("{}", err);
        std::process::exit(1);
    }
}
