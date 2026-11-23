plugins {
    application
}

java {
    toolchain {
        languageVersion = JavaLanguageVersion.of(21)
    }
}

dependencies {
    implementation(project(":inventory-core"))
}

application {
    mainClass = "com.example.inventory.app.InventoryApp"
}
