plugins {
    `java`
    application
}

repositories {
    mavenCentral()
}

dependencies {
    implementation(project(":lib"))
}

java {
    toolchain {
        languageVersion = JavaLanguageVersion.of(21)
    }
}

// Allow running any example via: ./gradlew :examples:run -PmainClass=examples.FetchTicker
application {
    mainClass.set(project.findProperty("mainClass") as String? ?: "examples.FetchTicker")
}

tasks.named<JavaExec>("run") {
    standardOutput = System.out
    errorOutput = System.err
    // Pass --args to the example
    if (project.hasProperty("args")) {
        args = (project.property("args") as String).split(" ").toList()
    }
}
